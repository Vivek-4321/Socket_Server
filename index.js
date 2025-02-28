
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const wrtc = require("wrtc");
const path = require("path");

// Create Express app, HTTP server and Socket.io instance
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Store active rooms and their participants
const rooms = {};

// WebRTC configuration
const webrtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.relay.metered.ca:80",
    },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "f5baae95181d1a3b2947f791",
      credential: "n67tiC1skstIO4zc",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "f5baae95181d1a3b2947f791",
      credential: "n67tiC1skstIO4zc",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "f5baae95181d1a3b2947f791",
      credential: "n67tiC1skstIO4zc",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "f5baae95181d1a3b2947f791",
      credential: "n67tiC1skstIO4zc",
    },
  ],
};

// Class to manage peer connections for a participant
class Participant {
  constructor(id, socket, roomId) {
    this.id = id;
    this.socket = socket;
    this.roomId = roomId;
    this.publisher = null; // RTCPeerConnection for receiving media from this participant
    this.consumers = new Map(); // Map of RTCPeerConnections for sending other participants' media
    this.stream = null; // The participant's media stream
  }

  // Create a peer connection to receive this participant's media
  async createPublisher(offer) {
    try {
      console.log(`Creating publisher connection for participant ${this.id}`);
      this.publisher = new wrtc.RTCPeerConnection(webrtcConfig);

      // Handle ICE candidates from the publisher connection
      this.publisher.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit("iceCandidate", {
            type: "publisher",
            candidate: event.candidate,
          });
        }
      };

      // Track connection state
      this.publisher.onconnectionstatechange = () => {
        console.log(
          `Publisher connection state for ${this.id}: ${this.publisher.connectionState}`
        );

        // If connection fails, clean up
        if (
          this.publisher.connectionState === "failed" ||
          this.publisher.connectionState === "closed"
        ) {
          console.warn(
            `Publisher connection for ${this.id} is ${this.publisher.connectionState}`
          );
        }
      };

      // Handle incoming tracks from the participant
      this.publisher.ontrack = (event) => {
        console.log(
          `Received track from participant ${this.id} (kind: ${event.track.kind})`
        );
        this.stream = event.streams[0];

        // Forward this stream to all other participants in the room
        this.forwardStreamToRoom();
      };

      // Set the remote description (offer from client)
      await this.publisher.setRemoteDescription(offer);

      // Create and set local description (answer)
      const answer = await this.publisher.createAnswer();
      await this.publisher.setLocalDescription(answer);

      // Send the answer back to the client
      this.socket.emit("sessionDescription", {
        type: "publisher",
        sdp: answer,
      });

      console.log(`Sent publisher answer to ${this.id}`);
    } catch (error) {
      console.error("Error creating publisher connection:", error);
    }
  }

  // Forward this participant's stream to all other participants in the room
  async forwardStreamToRoom() {
    if (!this.stream) return;

    const room = rooms[this.roomId];
    if (!room) return;

    console.log(
      `Forwarding stream from ${this.id} to ${
        Object.keys(room.participants).length - 1
      } other participants`
    );

    // For each participant in the room
    for (const [peerId, peer] of Object.entries(room.participants)) {
      // Skip self
      if (peerId === this.id) continue;

      // If we haven't created a consumer connection for this peer yet, create one
      await peer.createConsumerForPublisher(this.id, this.stream);
    }
  }

  // Create a peer connection to send media to this participant
  async createConsumerForPublisher(publisherId, stream) {
    try {
      // Skip if we already have a consumer for this publisher
      if (this.consumers.has(publisherId)) {
        console.log(
          `Already have a consumer for ${publisherId} -> ${this.id}, skipping`
        );
        return;
      }

      console.log(`Creating consumer connection: ${publisherId} -> ${this.id}`);

      // Create a new RTCPeerConnection
      const consumer = new wrtc.RTCPeerConnection(webrtcConfig);
      this.consumers.set(publisherId, consumer);

      // Add all tracks from the publisher's stream
      const tracks = stream.getTracks();
      console.log(`Adding ${tracks.length} tracks to consumer connection`);

      tracks.forEach((track) => {
        try {
          consumer.addTrack(track, stream);
        } catch (error) {
          console.error(`Error adding track to consumer connection:`, error);
        }
      });

      // Handle ICE candidates
      consumer.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit("iceCandidate", {
            type: "consumer",
            publisherId: publisherId,
            candidate: event.candidate,
          });
        }
      };

      // Monitor connection state
      consumer.onconnectionstatechange = () => {
        console.log(
          `Consumer connection state (${publisherId} -> ${this.id}): ${consumer.connectionState}`
        );
      };

      // Create an offer
      const offer = await consumer.createOffer();
      await consumer.setLocalDescription(offer);

      // Send the offer to the client
      this.socket.emit("sessionDescription", {
        type: "consumer",
        publisherId: publisherId,
        sdp: offer,
      });

      console.log(
        `Sent consumer offer to ${this.id} for publisher ${publisherId}`
      );
    } catch (error) {
      console.error(
        `Error creating consumer connection for ${publisherId}:`,
        error
      );
    }
  }

  // Set remote description on a consumer connection
  async setConsumerRemoteDescription(publisherId, answer) {
    try {
      const consumer = this.consumers.get(publisherId);
      if (consumer) {
        await consumer.setRemoteDescription(answer);
      }
    } catch (error) {
      console.error(
        `Error setting consumer remote description for ${publisherId}:`,
        error
      );
    }
  }

  // Handle ICE candidate for a specific connection
  async addIceCandidate(candidate, type, publisherId = null) {
    try {
      if (type === "publisher" && this.publisher) {
        await this.publisher.addIceCandidate(candidate);
      } else if (type === "consumer" && publisherId) {
        const consumer = this.consumers.get(publisherId);
        if (consumer) {
          await consumer.addIceCandidate(candidate);
        }
      }
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  }

  // Clean up all connections for this participant
  close() {
    // Close publisher connection
    if (this.publisher) {
      this.publisher.close();
      this.publisher = null;
    }

    // Close all consumer connections
    for (const consumer of this.consumers.values()) {
      consumer.close();
    }
    this.consumers.clear();

    // Release stream resources
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }
}

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  let participant = null;

  // Join a room
  socket.on("joinRoom", async (roomId) => {
    console.log(`Client ${socket.id} joining room ${roomId}`);

    // Leave current room if already in one
    if (participant) {
      leaveRoom();
    }

    // Create room if it doesn't exist
    if (!rooms[roomId]) {
      rooms[roomId] = {
        participants: {},
      };
    }

    // Create participant and add to room
    participant = new Participant(socket.id, socket, roomId);
    rooms[roomId].participants[socket.id] = participant;

    // Join socket.io room
    socket.join(roomId);

    // Get existing participants that have active streams
    const existingParticipants = [];
    for (const [peerId, peer] of Object.entries(rooms[roomId].participants)) {
      if (peerId !== socket.id && peer.stream) {
        existingParticipants.push(peerId);
      }
    }

    // Notify client they've joined
    socket.emit("roomJoined", {
      roomId,
      participants: existingParticipants,
    });

    // Notify other participants in the room
    socket.to(roomId).emit("participantJoined", socket.id);

    // For each existing participant with an active stream, create a consumer connection for the new participant
    for (const [peerId, peer] of Object.entries(rooms[roomId].participants)) {
      if (peerId !== socket.id && peer.stream) {
        // Forward the existing participant's stream to the new participant
        await participant.createConsumerForPublisher(peerId, peer.stream);
      }
    }
  });

  // Offer from publisher (client sending their media)
  socket.on("publisherOffer", async (offer) => {
    if (!participant) return;

    await participant.createPublisher(offer);
  });

  // Answer from consumer (client receiving media)
  socket.on("consumerAnswer", async (data) => {
    if (!participant) return;

    const { publisherId, sdp } = data;
    await participant.setConsumerRemoteDescription(publisherId, sdp);
  });

  // ICE candidate from client
  socket.on("iceCandidate", async (data) => {
    if (!participant) return;

    const { type, publisherId, candidate } = data;
    await participant.addIceCandidate(candidate, type, publisherId);
  });

  // Leave room function
  const leaveRoom = () => {
    if (!participant) return;

    const roomId = participant.roomId;
    const room = rooms[roomId];

    if (room) {
      // Remove participant from room
      delete room.participants[socket.id];

      // Clean up connections
      participant.close();

      // Notify others in the room
      socket.to(roomId).emit("participantLeft", socket.id);

      // Remove room if empty
      if (Object.keys(room.participants).length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} is now empty and has been removed`);
      }
    }

    // Leave socket.io room
    socket.leave(roomId);
    participant = null;
  };

  // Handle explicit leave request
  socket.on("leaveRoom", leaveRoom);

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    leaveRoom();
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SFU Server running on port ${PORT}`);
});
