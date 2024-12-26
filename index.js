const express = require("express");
const app = express();
const server = require("http").Server(app);
const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"], // Add this line explicitly
});
const cors = require("cors");
app.use(cors());

// Store both rooms and user information
const rooms = new Map();
const users = new Map(); // Store socket.id -> username mapping

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, username }) => {
    console.log("User Connected:", username);

    // Store username
    users.set(socket.id, username);

    socket.join(roomId);
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    // Store both socket.id and username in the room
    rooms.get(roomId).set(socket.id, username);

    // Send connected users with their usernames
    const roomUsers = Array.from(rooms.get(roomId)).map(([id, name]) => ({
      id,
      username: name,
    }));

    socket.emit("user-connected", roomUsers);
    socket.to(roomId).emit("user-joined", {
      id: socket.id,
      username: username,
    });
  });

  socket.on("call-user", ({ to, offer }) => {
    io.to(to).emit("incoming-call", {
      from: socket.id,
      fromUsername: users.get(socket.id),
      offer,
    });
  });

  socket.on("call-accepted", ({ to, answer }) => {
    io.to(to).emit("call-accepted", {
      from: socket.id,
      fromUsername: users.get(socket.id),
      answer,
    });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", {
      from: socket.id,
      candidate,
    });
  });

  socket.on("disconnect", () => {
    const username = users.get(socket.id);
    users.delete(socket.id);

    rooms.forEach((roomUsers, roomId) => {
      if (roomUsers.has(socket.id)) {
        roomUsers.delete(socket.id);
        io.to(roomId).emit("user-disconnected", {
          id: socket.id,
          username: username,
        });
      }
    });
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
