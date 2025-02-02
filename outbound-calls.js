// Code for authenticated outbound calls with your agent

import WebSocket from "ws";
import Twilio from "twilio";

// Call tracking store
const activeCallsStore = new Map();

export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const { 
    ELEVENLABS_API_KEY, 
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Store to track connected monitoring clients
  const monitoringClients = new Set();

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Helper function to broadcast call updates to all monitoring clients
  function broadcastCallUpdate(updateData) {
    monitoringClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'callUpdate',
          data: updateData
        }));
      }
    });
  }

  // WebSocket endpoint for call monitoring
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get('/call-monitor', { websocket: true }, (connection, req) => {
      console.log('[Monitor] New monitoring client connected');
      monitoringClients.add(connection.socket);

      // Send initial state
      connection.socket.send(JSON.stringify({
        type: 'initialState',
        data: Array.from(activeCallsStore.values())
      }));

      connection.socket.on('close', () => {
        monitoringClients.delete(connection.socket);
        console.log('[Monitor] Client disconnected');
      });
    });
  });

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, metadata = {} } = request.body;

    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://${request.headers.host}/outbound-call-twiml`
      });

      // Track the new call
      const callData = {
        callSid: call.sid,
        to: number,
        from: TWILIO_PHONE_NUMBER,
        status: call.status,
        startTime: new Date().toISOString(),
        metadata,
        logs: []
      };
      
      activeCallsStore.set(call.sid, callData);
      broadcastCallUpdate(callData);

      reply.send({ 
        success: true, 
        message: "Call initiated", 
        callSid: call.sid 
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({ 
        success: false, 
        error: "Failed to initiate call" 
      });
    }
  });

  // Get call history endpoint
  fastify.get("/calls", async (request, reply) => {
    reply.send(Array.from(activeCallsStore.values()));
  });

  // Get specific call details
  fastify.get("/calls/:callSid", async (request, reply) => {
    const callData = activeCallsStore.get(request.params.callSid);
    if (!callData) {
      reply.code(404).send({ error: "Call not found" });
      return;
    }
    reply.send(callData);
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;

      // Handle WebSocket errors
      ws.on('error', console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ 
                      event: "clear",
                      streamSid 
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio with call tracking
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log(`[Twilio] Received event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              
              // Update call status
              if (activeCallsStore.has(callSid)) {
                const callData = activeCallsStore.get(callSid);
                callData.status = 'in-progress';
                callData.streamSid = streamSid;
                callData.logs.push({
                  timestamp: new Date().toISOString(),
                  event: 'call_started',
                  details: 'Call connected successfully'
                });
                broadcastCallUpdate(callData);
              }
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));

                // Log media event
                if (callSid && activeCallsStore.has(callSid)) {
                  const callData = activeCallsStore.get(callSid);
                  callData.logs.push({
                    timestamp: new Date().toISOString(),
                    event: 'media_received',
                    details: 'Received audio from user'
                  });
                }
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (callSid && activeCallsStore.has(callSid)) {
                const callData = activeCallsStore.get(callSid);
                callData.status = 'completed';
                callData.endTime = new Date().toISOString();
                callData.logs.push({
                  timestamp: new Date().toISOString(),
                  event: 'call_ended',
                  details: 'Call completed successfully'
                });
                broadcastCallUpdate(callData);
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}
