import WebSocket from "ws";

// Store active connections
const clients = new Set();
// Store active calls
const activeCalls = new Map();

export function registerMonitoringRoutes(fastify) {
  // WebSocket endpoint for real-time monitoring
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/monitor", { websocket: true }, (connection, req) => {
      clients.add(connection);

      // Send current active calls to new connection
      const activeCallsArray = Array.from(activeCalls.values());
      connection.socket.send(JSON.stringify({
        type: 'initial',
        calls: activeCallsArray
      }));

      connection.socket.on('close', () => {
        clients.delete(connection);
      });
    });
  });

  // Initialize call monitoring
  fastify.post("/monitoring/calls", async (request, reply) => {
    const { callSid, phoneNumber } = request.body;
    
    if (!callSid || !phoneNumber) {
      return reply.code(400).send({ error: "CallSid and phoneNumber are required" });
    }

    const callData = {
      callSid,
      phoneNumber,
      status: 'initiated',
      startTime: new Date().toISOString(),
      events: [{
        timestamp: new Date().toISOString(),
        type: 'initiated'
      }]
    };

    activeCalls.set(callSid, callData);
    broadcastUpdate('call_initiated', callData);

    reply.send({ success: true, call: callData });
  });

  // Update call status
  fastify.put("/monitoring/calls/:callSid", async (request, reply) => {
    const { callSid } = request.params;
    const { status, event } = request.body;

    if (!activeCalls.has(callSid)) {
      return reply.code(404).send({ error: "Call not found" });
    }

    const call = activeCalls.get(callSid);
    call.status = status;
    call.events.push({
      timestamp: new Date().toISOString(),
      type: event
    });

    if (status === 'completed') {
      call.endTime = new Date().toISOString();
      activeCalls.delete(callSid);
    } else {
      activeCalls.set(callSid, call);
    }

    broadcastUpdate('call_updated', call);
    reply.send({ success: true, call });
  });

  // Get active calls
  fastify.get("/monitoring/calls", async (request, reply) => {
    const calls = Array.from(activeCalls.values());
    reply.send({ calls });
  });

  // Get specific call details
  fastify.get("/monitoring/calls/:callSid", async (request, reply) => {
    const { callSid } = request.params;
    const call = activeCalls.get(callSid);

    if (!call) {
      return reply.code(404).send({ error: "Call not found" });
    }

    reply.send({ call });
  });
}

// Function to broadcast updates to all connected clients
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(message);
    }
  });
}

// Function to update call status and broadcast
export function updateCallStatus(callSid, status, event) {
  const call = activeCalls.get(callSid);
  if (call) {
    call.status = status;
    call.events.push({
      timestamp: new Date().toISOString(),
      type: event
    });

    if (status === 'completed') {
      call.endTime = new Date().toISOString();
      activeCalls.delete(callSid);
    } else {
      activeCalls.set(callSid, call);
    }

    broadcastUpdate('call_updated', call);
  }
}
