const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true
    }
});

const activeUsers = {};
const chatRooms = {};
const voiceCalls = {};
const callInvitations = {};

function findSocketIdByUserId(userId) {
  return activeUsers[userId] ? activeUsers[userId].socketId : null;
}

app.get('/status', (req, res) => {
  res.json({ 
    status: 'OK', 
    connections: Object.keys(activeUsers).length,
    rooms: Object.keys(chatRooms).length,
    activeCalls: Object.keys(voiceCalls).length
  });
});

app.get('/rooms', (req, res) => {
  const roomList = Object.keys(chatRooms).map(roomId => ({
    id: roomId,
    name: chatRooms[roomId].name,
    participants: Object.keys(chatRooms[roomId].participants).length,
    hasActiveCall: !!voiceCalls[roomId]
  }));
  res.json(roomList);
});

app.get('/rooms/:roomId/messages', (req, res) => {
  const roomId = req.params.roomId;
  
  if (!chatRooms[roomId]) {
    chatRooms[roomId] = {
      id: roomId,
      name: `Chat ${roomId}`,
      created: new Date(),
      participants: {},
      messages: []
    };
  }
  
  res.json(chatRooms[roomId].messages);
});

// Nuevo endpoint para información de llamadas de voz
app.get('/rooms/:roomId/voice-call', (req, res) => {
  const roomId = req.params.roomId;
  
  if (voiceCalls[roomId]) {
    res.json({
      active: true,
      participants: Object.keys(voiceCalls[roomId].participants).length,
      startedAt: voiceCalls[roomId].startedAt
    });
  } else {
    res.json({
      active: false
    });
  }
});

app.post('/message_deleted', (req, res) => {
  const { roomId, messageId, userId } = req.body;
  
  if (!roomId || !messageId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Se requieren roomId y messageId'
    });
  }
  
  // Verificar si la sala existe
  if (!chatRooms[roomId]) {
    return res.status(404).json({
      success: false,
      error: 'Sala no encontrada'
    });
  }
  
  // Buscar el mensaje en la sala
  const messageIndex = chatRooms[roomId].messages.findIndex(msg => 
    msg.id === messageId || 
    msg.id.endsWith(messageId) || 
    (typeof messageId === 'string' && msg.id.includes(messageId))
  );
  
  if (messageIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Mensaje no encontrado'
    });
  }
  
  // Verificar permisos (opcional, ya que esta verificación debería hacerse en el backend de Symfony)
  const message = chatRooms[roomId].messages[messageIndex];
  
  // Marcar el mensaje como eliminado
  chatRooms[roomId].messages[messageIndex].content = '[Mensaje eliminado]';
  chatRooms[roomId].messages[messageIndex].deleted = true;
  chatRooms[roomId].messages[messageIndex].deletedBy = userId;
  chatRooms[roomId].messages[messageIndex].deletedAt = new Date();
  
  // Emitir evento a todos los clientes conectados a la sala
  io.to(roomId).emit('message_deleted', {
    roomId,
    messageId: message.id,
    deletedBy: userId,
    timestamp: new Date()
  });
  
  console.log(`Message ${messageId} deleted in room ${roomId} by user ${userId} through API`);
  
  return res.json({
    success: true,
    message: 'Mensaje eliminado correctamente'
  });
});

app.post('/rooms', (req, res) => {
  const { name, creatorId, creatorName, participantIds = [] } = req.body;
  
  const roomName = name || 'Nuevo chat';
  const creator = creatorId || 'anonymous';
  const creatorDisplayName = creatorName || 'Anonymous User';
  
  const roomId = `room_${Date.now()}`;
  
  chatRooms[roomId] = {
    id: roomId,
    name: roomName,
    created: new Date(),
    participants: {
      [creator]: { id: creator, name: creatorDisplayName, role: 'creator', active: true }
    },
    messages: []
  };
  
  participantIds.forEach(pId => {
    if (pId !== creator) {
      chatRooms[roomId].participants[pId] = { 
        id: pId, 
        name: `User ${pId}`,
        role: 'member',
        active: false
      };
    }
  });
  
  io.emit('room_created', {
    roomId,
    name: roomName,
    creator: creator
  });
  
  res.status(201).json({ roomId, room: chatRooms[roomId] });
});

app.post('/rooms/:roomId/messages', (req, res) => {
  const { content, senderId, senderName, type = 'text' } = req.body;
  const roomId = req.params.roomId;
  
  if (!chatRooms[roomId]) {
    chatRooms[roomId] = {
      id: roomId,
      name: `Chat ${roomId}`,
      created: new Date(),
      participants: {},
      messages: []
    };
  }
  
  const userId = senderId || 'anonymous';
  const userName = senderName || 'Anonymous User';
  const messageContent = content || 'Mensaje vacío';
  
  const message = {
    id: `msg_${Date.now()}`,
    roomId,
    senderId: userId,
    senderName: userName,
    content: messageContent,
    type,
    timestamp: new Date()
  };
  
  chatRooms[roomId].messages.push(message);
  
  if (chatRooms[roomId].messages.length > 100) {
    chatRooms[roomId].messages.shift();
  }
  
  io.to(roomId).emit('message', message);
  
  res.status(201).json(message);
});

// Nuevo endpoint para iniciar llamadas desde API
app.post('/rooms/:roomId/voice-call', (req, res) => {
  const { callerId, callerName } = req.body;
  const roomId = req.params.roomId;
  
  if (!chatRooms[roomId]) {
    return res.status(404).json({
      success: false,
      error: 'Sala de chat no encontrada'
    });
  }
  
  if (!callerId || !callerName) {
    return res.status(400).json({
      success: false,
      error: 'Se requiere información del llamante'
    });
  }
  
  // Verificar si ya hay una llamada activa
  if (voiceCalls[roomId]) {
    return res.json({
      success: true,
      callId: roomId,
      alreadyActive: true,
      participants: Object.keys(voiceCalls[roomId].participants).length
    });
  }
  
  // Iniciar nueva llamada
  voiceCalls[roomId] = {
    roomId: roomId,
    startedAt: new Date(),
    startedBy: callerId,
    participants: {
      [callerId]: {
        userId: callerId,
        userName: callerName,
        joinedAt: new Date()
      }
    }
  };
  
  // Emitir mensaje al chat
  const systemMessage = {
    id: `msg_${Date.now()}`,
    roomId: roomId,
    senderId: 'system',
    senderName: 'System',
    content: `${callerName} ha iniciado una llamada de voz`,
    type: 'system',
    timestamp: new Date()
  };
  
  chatRooms[roomId].messages.push(systemMessage);
  io.to(roomId).emit('message', systemMessage);
  
  // Notificar a todos sobre la llamada
  io.to(roomId).emit('voice_call_started', {
    roomId: roomId,
    callerId: callerId,
    callerName: callerName
  });
  
  return res.json({
    success: true,
    callId: roomId,
    startedAt: voiceCalls[roomId].startedAt
  });
});

// Endpoint para finalizar llamadas desde API
app.post('/rooms/:roomId/voice-call/end', (req, res) => {
  const { userId, userName } = req.body;
  const roomId = req.params.roomId;
  
  if (!voiceCalls[roomId]) {
    return res.status(404).json({
      success: false,
      error: 'No hay llamada activa en esta sala'
    });
  }
  
  // Enviar mensaje de finalización de llamada
  const systemMessage = {
    id: `msg_${Date.now()}`,
    roomId: roomId,
    senderId: 'system',
    senderName: 'System',
    content: `${userName || 'Alguien'} ha finalizado la llamada de voz`,
    type: 'system',
    timestamp: new Date()
  };
  
  chatRooms[roomId].messages.push(systemMessage);
  io.to(roomId).emit('message', systemMessage);
  
  // Notificar a todos que la llamada ha terminado
  io.to(roomId).emit('voice_call_end', {
    roomId: roomId,
    userId: userId,
    userName: userName
  });
  
  // Eliminar la llamada del registro
  delete voiceCalls[roomId];
  
  return res.json({
    success: true,
    message: 'Llamada finalizada'
  });
});

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  socket.on('authenticate', (userData) => {
    const userId = userData?.userId || `anon_${Date.now()}`;
    const userName = userData?.userName || `User ${userId}`;
    
    activeUsers[userId] = {
      socketId: socket.id,
      userName,
      roomsJoined: []
    };
    
    socket.userId = userId;
    socket.userName = userName;
    
    console.log(`User authenticated: ${userName} (${userId})`);
    socket.emit('authenticated', { userId, userName });
  });
  
  socket.on('join_room', ({ roomId, userId }) => {
    const actualRoomId = roomId || 'default_room';
    const actualUserId = userId || socket.userId || `anon_${Date.now()}`;
    const actualUserName = socket.userName || `User ${actualUserId}`;
    
    if (!chatRooms[actualRoomId]) {
      chatRooms[actualRoomId] = {
        id: actualRoomId,
        name: `Chat ${actualRoomId}`,
        created: new Date(),
        participants: {},
        messages: []
      };
    }
    
    socket.join(actualRoomId);
    
    if (chatRooms[actualRoomId].participants[actualUserId]) {
      chatRooms[actualRoomId].participants[actualUserId].active = true;
    } else {
      chatRooms[actualRoomId].participants[actualUserId] = {
        id: actualUserId,
        name: actualUserName,
        role: 'member',
        active: true
      };
    }
    
    if (activeUsers[actualUserId]) {
      if (!activeUsers[actualUserId].roomsJoined.includes(actualRoomId)) {
        activeUsers[actualUserId].roomsJoined.push(actualRoomId);
      }
    }
    
    io.to(actualRoomId).emit('user_joined', {
      roomId: actualRoomId,
      userId: actualUserId,
      userName: actualUserName,
      timestamp: new Date()
    });
    
    const systemMessage = {
      id: `msg_${Date.now()}`,
      roomId: actualRoomId,
      senderId: 'system',
      senderName: 'System',
      content: `${actualUserName} has joined the chat`,
      type: 'system',
      timestamp: new Date()
    };
    
    chatRooms[actualRoomId].messages.push(systemMessage);
    // io.to(actualRoomId).emit('message', systemMessage);
    
    // Si hay una llamada activa en la sala, informar al usuario que acaba de unirse
    if (voiceCalls[actualRoomId]) {
      socket.emit('voice_call_active', {
        roomId: actualRoomId,
        startedBy: voiceCalls[actualRoomId].startedBy,
        startedAt: voiceCalls[actualRoomId].startedAt,
        participants: Object.keys(voiceCalls[actualRoomId].participants).length
      });
    }
    
    console.log(`User ${actualUserName} joined room ${actualRoomId}`);
  });
  
  socket.on('leave_room', ({ roomId, userId }) => {
    const actualRoomId = roomId || 'default_room';
    const actualUserId = userId || socket.userId || `anon_${Date.now()}`;
    const actualUserName = socket.userName || `User ${actualUserId}`;
    
    if (!chatRooms[actualRoomId]) return;
    
    socket.leave(actualRoomId);
    
    if (chatRooms[actualRoomId].participants[actualUserId]) {
      chatRooms[actualRoomId].participants[actualUserId].active = false;
    }
    
    if (activeUsers[actualUserId]) {
      activeUsers[actualUserId].roomsJoined = activeUsers[actualUserId].roomsJoined.filter(id => id !== actualRoomId);
    }
    
    io.to(actualRoomId).emit('user_left', {
      roomId: actualRoomId,
      userId: actualUserId,
      userName: actualUserName,
      timestamp: new Date()
    });
    
    const systemMessage = {
      id: `msg_${Date.now()}`,
      roomId: actualRoomId,
      senderId: 'system',
      senderName: 'System',
      content: `${actualUserName} has left the chat`,
      type: 'system',
      timestamp: new Date()
    };
    
    chatRooms[actualRoomId].messages.push(systemMessage);
    // io.to(actualRoomId).emit('message', systemMessage);
    
    // Si el usuario estaba en una llamada, notificar que ha salido
    if (voiceCalls[actualRoomId] && voiceCalls[actualRoomId].participants[actualUserId]) {
      delete voiceCalls[actualRoomId].participants[actualUserId];
      
      // Si ya no quedan participantes, finalizar la llamada
      if (Object.keys(voiceCalls[actualRoomId].participants).length === 0) {
        delete voiceCalls[actualRoomId];
        
        io.to(actualRoomId).emit('voice_call_end', {
          roomId: actualRoomId,
          userId: actualUserId,
          userName: actualUserName,
          reason: 'no_participants'
        });
      } else {
        // Notificar a los demás participantes
        io.to(actualRoomId).emit('voice_user_left', {
          roomId: actualRoomId,
          userId: actualUserId,
          userName: actualUserName
        });
      }
    }
    
    console.log(`User ${actualUserName} left room ${actualRoomId}`);
  });
  
  socket.on('send_message', ({ roomId, content, type = 'text' }) => {
    const actualRoomId = roomId || 'default_room';
    const actualUserId = socket.userId || `anon_${Date.now()}`;
    const actualUserName = socket.userName || `User ${actualUserId}`;
    const messageContent = content || 'Empty message';
    
    if (!chatRooms[actualRoomId]) {
      chatRooms[actualRoomId] = {
        id: actualRoomId,
        name: `Chat ${actualRoomId}`,
        created: new Date(),
        participants: {},
        messages: []
      };
      
      chatRooms[actualRoomId].participants[actualUserId] = {
        id: actualUserId,
        name: actualUserName,
        role: 'creator',
        active: true
      };
    }
    
    const message = {
      id: `msg_${Date.now()}`,
      roomId: actualRoomId,
      senderId: actualUserId,
      senderName: actualUserName,
      content: messageContent,
      type,
      timestamp: new Date()
    };
    
    chatRooms[actualRoomId].messages.push(message);
    
    if (chatRooms[actualRoomId].messages.length > 100) {
      chatRooms[actualRoomId].messages.shift();
    }
    
    io.to(actualRoomId).emit('message', message);
    
    console.log(`New message in room ${actualRoomId} from ${actualUserName}: ${messageContent.substring(0, 30)}...`);
  });
  
  socket.on('typing', ({ roomId, isTyping }) => {
    const actualRoomId = roomId || 'default_room';
    const actualUserId = socket.userId || `anon_${Date.now()}`;
    const actualUserName = socket.userName || `User ${actualUserId}`;
    
    socket.to(actualRoomId).emit('user_typing', {
      roomId: actualRoomId,
      userId: actualUserId,
      userName: actualUserName,
      isTyping: !!isTyping
    });
  });

  socket.on('message_deleted', (data) => {
    const actualRoomId = data.roomId || 'default_room';
    const actualUserId = socket.userId || `anon_${Date.now()}`;
    const actualUserName = socket.userName || `User ${actualUserId}`;
    const messageId = data.messageId;
    
    console.log(`Message deletion requested in room ${actualRoomId} by ${actualUserName}, message ID: ${messageId}`);
    
    if (chatRooms[actualRoomId]) {
      // Buscar el mensaje usando un enfoque más flexible
      const messageIndex = chatRooms[actualRoomId].messages.findIndex(msg => 
        msg.id === messageId || 
        msg.id.endsWith(messageId) || 
        (typeof messageId === 'string' && msg.id.includes(messageId))
      );
      
      if (messageIndex !== -1) {
        const message = chatRooms[actualRoomId].messages[messageIndex];
        const participant = chatRooms[actualRoomId].participants[actualUserId];
        
        // Verificar permisos: solo el autor o un administrador puede eliminar
        if (message.senderId === actualUserId || (participant && ['admin', 'creator'].includes(participant.role))) {
          // Actualizar el mensaje
          chatRooms[actualRoomId].messages[messageIndex].content = '[Mensaje eliminado]';
          chatRooms[actualRoomId].messages[messageIndex].deleted = true;
          chatRooms[actualRoomId].messages[messageIndex].deletedBy = actualUserId;
          chatRooms[actualRoomId].messages[messageIndex].deletedAt = new Date();
          
          // Emitir evento a todos los clientes conectados a la sala
          io.to(actualRoomId).emit('message_deleted', {
            roomId: actualRoomId,
            messageId: message.id, // Usar el ID completo del mensaje
            deletedBy: actualUserId,
            timestamp: new Date()
          });
          
          console.log(`Message ${message.id} was deleted in room ${actualRoomId}`);
        } else {
          console.log(`User ${actualUserId} not authorized to delete message ${messageId}`);
          // Opcionalmente, informar al cliente sobre el error
          socket.emit('error', {
            type: 'delete_unauthorized',
            message: 'No tienes permiso para eliminar este mensaje',
            roomId: actualRoomId,
            messageId: messageId
          });
        }
      } else {
        console.log(`Message ${messageId} not found in room ${actualRoomId}`);
        // Opcionalmente, informar al cliente sobre el error
        socket.emit('error', {
          type: 'message_not_found',
          message: 'Mensaje no encontrado',
          roomId: actualRoomId,
          messageId: messageId
        });
      }
    } else {
      console.log(`Room ${actualRoomId} not found`);
      // Opcionalmente, informar al cliente sobre el error
      socket.emit('error', {
        type: 'room_not_found',
        message: 'Sala no encontrada',
        roomId: actualRoomId
      });
    }
  });

  // =============================================================
  // EVENTOS PARA LLAMADAS DE VOZ
  // =============================================================
  

  socket.on('voice_call_start', (data) => {
    const roomId = data.roomId;
    const userId = data.userId || socket.userId;
    const userName = data.userName || socket.userName;
    
    console.log(`Llamada de voz iniciada en sala ${roomId} por ${userName}`);
    
    // Registrar la llamada
    if (!voiceCalls[roomId]) {
      voiceCalls[roomId] = {
        roomId: roomId,
        startedAt: new Date(),
        startedBy: userId,
        participants: {
          [userId]: {
            userId: userId,
            userName: userName,
            joinedAt: new Date()
          }
        }
      };
    } else {
      // Si ya existe, añadir este usuario a los participantes
      voiceCalls[roomId].participants[userId] = {
        userId: userId,
        userName: userName,
        joinedAt: new Date()
      };
    }
    
    // Crear una sala específica para la llamada
    socket.join(`voice_${roomId}`);
    
    // Enviar mensaje al chat
    const systemMessage = {
      id: `msg_${Date.now()}`,
      roomId: roomId,
      senderId: 'system',
      senderName: 'System',
      content: `${userName} ha iniciado una llamada de voz`,
      type: 'system',
      timestamp: new Date()
    };
    
    if (chatRooms[roomId] && chatRooms[roomId].messages) {
      chatRooms[roomId].messages.push(systemMessage);
      io.to(roomId).emit('message', systemMessage);
    }
  });

  socket.on('voice_call_invite_all', (data) => {
    const roomId = data.roomId;
    const callerId = data.callerId || socket.userId;
    const callerName = data.callerName || socket.userName;
    
    if (!chatRooms[roomId]) return;
    
    console.log(`${callerName} está invitando a todos los participantes de la sala ${roomId} a una llamada`);
    
    // Notificar a todos los participantes activos en la sala
    Object.keys(chatRooms[roomId].participants).forEach(participantId => {
      if (participantId !== callerId && chatRooms[roomId].participants[participantId].active) {
        const userSocketId = findSocketIdByUserId(participantId);
        
        if (userSocketId) {
          io.to(userSocketId).emit('voice_call_invite', {
            roomId: roomId,
            callerId: callerId,
            callerName: callerName
          });
        }
      }
    });
  });

  // Cuando un usuario inicia una llamada en una sala
  socket.on('voice_call_started', (data) => {
    const roomId = data.roomId;
    const callerId = data.callerId || socket.userId;
    const callerName = data.callerName || socket.userName;
    
    console.log(`Voice call started in room ${roomId} by ${callerName} (${callerId})`);
    
    // Registrar la llamada
    if (!voiceCalls[roomId]) {
      voiceCalls[roomId] = {
        roomId: roomId,
        startedAt: new Date(),
        startedBy: callerId,
        participants: {
          [callerId]: {
            userId: callerId,
            userName: callerName,
            joinedAt: new Date()
          }
        }
      };
      
      // Crear una sala específica para la llamada
      socket.join(`voice_${roomId}`);
      
      // Enviar mensaje al chat
      const systemMessage = {
        id: `msg_${Date.now()}`,
        roomId: roomId,
        senderId: 'system',
        senderName: 'System',
        content: `${callerName} ha iniciado una llamada de voz`,
        type: 'system',
        timestamp: new Date()
      };
      
      if (chatRooms[roomId] && chatRooms[roomId].messages) {
        chatRooms[roomId].messages.push(systemMessage);
        io.to(roomId).emit('message', systemMessage);
      }
      
      // Notificar a todos sobre la llamada
      io.to(roomId).emit('voice_call_started', {
        roomId: roomId,
        callerId: callerId,
        callerName: callerName
      });
    } else {
      console.log(`Call already active in room ${roomId}`);
      
      // Si ya existe la llamada, agregar al usuario como participante
      voiceCalls[roomId].participants[callerId] = {
        userId: callerId,
        userName: callerName,
        joinedAt: new Date()
      };
      
      socket.join(`voice_${roomId}`);
      
      // Notificar a los demás participantes
      socket.to(`voice_${roomId}`).emit('voice_user_joined', {
        roomId: roomId,
        userId: callerId,
        userName: callerName
      });
    }
  });
  
  // Invitar a participantes a una llamada (mensaje a todos en la sala de chat)
  socket.on('voice_room_call', (data) => {
    const roomId = data.roomId;
    const callerId = data.callerId || socket.userId;
    const callerName = data.callerName || socket.userName;
    
    if (!chatRooms[roomId]) {
      return;
    }
    
    // Inicializar el registro de invitaciones para esta sala si no existe
    if (!callInvitations[roomId]) {
      callInvitations[roomId] = {
        callerId: callerId,
        callerName: callerName,
        invitedUsers: {},
        respondedUsers: {}
      };
    }
    
    // Notificar a todos los participantes activos en la sala
    const participants = Object.keys(chatRooms[roomId].participants);
    
    participants.forEach(participantId => {
      // No notificar al creador de la llamada
      if (participantId !== callerId && chatRooms[roomId].participants[participantId].active) {
        // Verificar si ya se invitó a este usuario
        if (callInvitations[roomId].invitedUsers[participantId]) {
          console.log(`Usuario ${participantId} ya fue invitado a la llamada en ${roomId}`);
          return;
        }
        
        // Verificar si ya respondió a la invitación
        if (callInvitations[roomId].respondedUsers[participantId]) {
          console.log(`Usuario ${participantId} ya respondió a la llamada en ${roomId}`);
          return;
        }
        
        // Buscar el socket del participante
        const userIdToNotify = participantId;
        const userSocketId = findSocketIdByUserId(userIdToNotify);
        
        if (userSocketId) {
          // Marcar como invitado
          callInvitations[roomId].invitedUsers[participantId] = {
            time: new Date(),
            socketId: userSocketId
          };
          
          io.to(userSocketId).emit('voice_call_offer', {
            roomId: roomId,
            callerId: callerId,
            callerName: callerName,
            targetUserId: userIdToNotify
          });
        }
      }
    });
    
    // Emitir un mensaje en la sala de chat
    const systemMessage = {
      id: `msg_${Date.now()}`,
      roomId: roomId,
      senderId: 'system',
      senderName: 'System',
      content: `${callerName} ha iniciado una llamada de voz.`,
      type: 'system',
      timestamp: new Date()
    };
    
    if (chatRooms[roomId].messages) {
      chatRooms[roomId].messages.push(systemMessage);
      io.to(roomId).emit('message', systemMessage);
    }
  });
  
  // Cuando un usuario envía una oferta WebRTC a otro usuario
  socket.on('voice_call_offer', (data) => {
    console.log(`Voice call offer from ${socket.userName} to user ${data.targetUserId}`);
    
    const targetSocketId = findSocketIdByUserId(data.targetUserId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('voice_call_offer', {
        roomId: data.roomId,
        callerId: data.callerId || socket.userId,
        callerName: data.callerName || socket.userName,
        targetUserId: data.targetUserId,
        sdp: data.sdp
      });
    } else {
      console.log(`Target user ${data.targetUserId} not found or offline`);
      socket.emit('error', {
        type: 'user_offline',
        message: 'El usuario está desconectado',
        userId: data.targetUserId
      });
    }
  });
  
  // Cuando un usuario acepta una llamada
  socket.on('voice_call_accept', (data) => {
    const roomId = data.roomId;
    const callerId = data.callerId;
    const userId = data.userId || socket.userId;
    const userName = data.userName || socket.userName;
    
    console.log(`${userName} aceptó la llamada en sala ${roomId}`);
    
    // Unirse a la sala de voz
    socket.join(`voice_${roomId}`);
    
    // Registrar al usuario como participante de la llamada
    if (!voiceCalls[roomId]) {
      // Crear la entrada de llamada si no existe
      voiceCalls[roomId] = {
        roomId: roomId,
        startedAt: new Date(),
        startedBy: callerId,
        participants: {}
      };
    }
    
    voiceCalls[roomId].participants[userId] = {
      userId: userId,
      userName: userName,
      joinedAt: new Date()
    };
    
    // Notificar a todos los participantes
    io.to(`voice_${roomId}`).emit('voice_call_joined', {
      roomId: roomId,
      userId: userId,
      userName: userName
    });
    
    // Notificar al creador de la llamada
    const callerSocketId = findSocketIdByUserId(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('voice_call_accepted', {
        roomId: roomId,
        userId: userId,
        userName: userName
      });
    }
  });
  
  // Cuando un usuario rechaza una llamada
  socket.on('voice_call_reject', (data) => {
    const roomId = data.roomId;
    const callerId = data.callerId;
    const userId = data.userId || socket.userId;
    const userName = data.userName || socket.userName;
    
    console.log(`${userName} rechazó la llamada en sala ${roomId}`);
    
    // Notificar al creador de la llamada
    const callerSocketId = findSocketIdByUserId(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('voice_call_rejected', {
        roomId: roomId,
        userId: userId,
        userName: userName
      });
    }
  });

  
  socket.on('voice_audio_chunk', (data) => {
    const roomId = data.roomId;
    const userId = data.userId || socket.userId;
    const userName = data.userName || socket.userName;
    
    // Reenviar el audio a todos los demás participantes en la llamada
    socket.to(`voice_${roomId}`).emit('voice_audio_chunk', {
      roomId: roomId,
      userId: userId,
      userName: userName,
      audioChunk: data.audioChunk
    });
  });
  
  // Intercambio de candidatos ICE para WebRTC
  socket.on('voice_ice_candidate', (data) => {
    const targetSocketId = findSocketIdByUserId(data.targetUserId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('voice_ice_candidate', {
        roomId: data.roomId,
        senderId: data.senderId || socket.userId,
        targetUserId: data.targetUserId,
        candidate: data.candidate
      });
    }
  });
  
  // Cuando un usuario finaliza una llamada
  socket.on('voice_call_end', (data) => {
    const roomId = data.roomId;
    const userId = data.userId || socket.userId;
    const userName = data.userName || socket.userName;
    
    console.log(`Llamada finalizada por ${userName} en sala ${roomId}`);
    
    // Limpiar registro de la llamada
    delete voiceCalls[roomId];
    
    // Enviar mensaje al chat
    const systemMessage = {
      id: `msg_${Date.now()}`,
      roomId: roomId,
      senderId: 'system',
      senderName: 'System',
      content: `${userName} ha finalizado la llamada de voz`,
      type: 'system',
      timestamp: new Date()
    };
    
    if (chatRooms[roomId] && chatRooms[roomId].messages) {
      chatRooms[roomId].messages.push(systemMessage);
      io.to(roomId).emit('message', systemMessage);
    }
    
    // Notificar a todos los participantes
    io.to(`voice_${roomId}`).emit('voice_call_end', {
      roomId: roomId,
      userId: userId,
      userName: userName
    });
  });
  
  socket.on('disconnect', () => {
    const userId = socket.userId || null;
    
    console.log(`User disconnected: ${socket.userName || 'Unknown'} (${userId || 'no ID'})`);
    
    if (userId && activeUsers[userId]) {
      const userRooms = [...activeUsers[userId].roomsJoined];
      
      userRooms.forEach(roomId => {
        if (chatRooms[roomId] && chatRooms[roomId].participants[userId]) {
          chatRooms[roomId].participants[userId].active = false;
          
          io.to(roomId).emit('user_left', {
            roomId,
            userId,
            userName: socket.userName || `User ${userId}`,
            timestamp: new Date()
          });
          
          const systemMessage = {
            id: `msg_${Date.now()}`,
            roomId,
            senderId: 'system',
            senderName: 'System',
            content: `${socket.userName || `User ${userId}`} has disconnected`,
            type: 'system',
            timestamp: new Date()
          };
          
          chatRooms[roomId].messages.push(systemMessage);
          io.to(roomId).emit('message', systemMessage);
          
          // Si el usuario estaba en una llamada, notificar su salida
          if (voiceCalls[roomId] && voiceCalls[roomId].participants[userId]) {
            delete voiceCalls[roomId].participants[userId];
            
            // Si ya no quedan participantes, finalizar la llamada
            if (Object.keys(voiceCalls[roomId].participants).length === 0) {
              delete voiceCalls[roomId];
              
              io.to(roomId).emit('voice_call_end', {
                roomId: roomId,
                userId: userId,
                userName: socket.userName || `User ${userId}`,
                reason: 'no_participants'
              });
            } else {
              // Notificar a los demás participantes
              io.to(`voice_${roomId}`).emit('voice_user_left', {
                roomId: roomId,
                userId: userId,
                userName: socket.userName || `User ${userId}`
              });
            }
          }
        }
      });
      
      delete activeUsers[userId];
    }
  });

  socket.onAny((event, ...args) => {
    console.log(`Received unhandled event: ${event}`, args);
    if (event.startsWith('chat_') && args.length > 0) {
      const roomId = args[0].roomId || 'default_room';
      io.to(roomId).emit(event, ...args);
    }
  });
});

const PORT = process.env.PORT || 3033;
server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});