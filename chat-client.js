class ChatClient {
    constructor(serverUrl = 'http://localhost:3033') {
      this.serverUrl = serverUrl;
      this.socket = null;
      this.isConnected = false;
      this.isAuthenticated = false;
      this.currentRoom = null;
      this.userId = null;
      this.userName = null;
      this.callbacks = {
        onConnect: () => {},
        onDisconnect: () => {},
        onAuthenticated: () => {},
        onError: () => {},
        onMessage: () => {},
        onUserJoined: () => {},
        onUserLeft: () => {},
        onUserTyping: () => {},
        onRoomCreated: () => {}
      };
    }
  
    /**
     * Conectarse al servidor WebSocket
     */
    connect() {
      // Cargar Socket.io desde CDN si no está disponible
      if (!window.io) {
        console.warn('Socket.io no encontrado, cargando desde CDN...');
        const script = document.createElement('script');
        script.src = 'https://cdn.socket.io/4.7.2/socket.io.min.js';
        script.onload = () => this._initializeSocket();
        document.head.appendChild(script);
      } else {
        this._initializeSocket();
      }
      return this;
    }
  
    /**
     * Inicializar la conexión Socket.io
     * @private
     */
    _initializeSocket() {
      this.socket = io(this.serverUrl);
  
      // Eventos del sistema
      this.socket.on('connect', () => {
        this.isConnected = true;
        this.callbacks.onConnect();
      });
  
      this.socket.on('disconnect', () => {
        this.isConnected = false;
        this.isAuthenticated = false;
        this.callbacks.onDisconnect();
      });
  
      this.socket.on('error', (error) => {
        this.callbacks.onError(error);
      });
  
      // Autenticación
      this.socket.on('authenticated', (data) => {
        this.isAuthenticated = true;
        this.userId = data.userId;
        this.userName = data.userName;
        this.callbacks.onAuthenticated(data);
      });
  
      // Eventos de chat
      this.socket.on('message', (message) => {
        this.callbacks.onMessage(message);
      });
  
      this.socket.on('user_joined', (data) => {
        this.callbacks.onUserJoined(data);
      });
  
      this.socket.on('user_left', (data) => {
        this.callbacks.onUserLeft(data);
      });
  
      this.socket.on('user_typing', (data) => {
        this.callbacks.onUserTyping(data);
      });
  
      this.socket.on('room_created', (data) => {
        this.callbacks.onRoomCreated(data);
      });
    }
  
    /**
     * Autenticarse con el servidor
     * @param {string} userId - ID de usuario
     * @param {string} userName - Nombre de usuario
     */
    authenticate(userId, userName) {
      if (!this.isConnected) {
        throw new Error('No hay conexión al servidor');
      }
  
      this.socket.emit('authenticate', { userId, userName });
      return this;
    }
  
    /**
     * Unirse a una sala de chat
     * @param {string} roomId - ID de la sala
     */
    joinRoom(roomId) {
      if (!this.isAuthenticated) {
        throw new Error('El usuario no está autenticado');
      }
  
      this.socket.emit('join_room', { roomId, userId: this.userId });
      this.currentRoom = roomId;
      return this;
    }
  
    /**
     * Abandonar una sala de chat
     * @param {string} roomId - ID de la sala (opcional, usa la sala actual por defecto)
     */
    leaveRoom(roomId = null) {
      if (!this.isAuthenticated) {
        throw new Error('El usuario no está autenticado');
      }
  
      const targetRoom = roomId || this.currentRoom;
      if (!targetRoom) {
        throw new Error('No hay sala activa');
      }
  
      this.socket.emit('leave_room', { roomId: targetRoom, userId: this.userId });
      
      if (targetRoom === this.currentRoom) {
        this.currentRoom = null;
      }
      
      return this;
    }
  
    /**
     * Enviar un mensaje a la sala actual
     * @param {string} content - Contenido del mensaje
     * @param {string} type - Tipo de mensaje (text, image, etc.)
     */
    sendMessage(content, type = 'text') {
      if (!this.isAuthenticated) {
        throw new Error('El usuario no está autenticado');
      }
  
      if (!this.currentRoom) {
        throw new Error('No hay sala activa');
      }
  
      this.socket.emit('send_message', {
        roomId: this.currentRoom,
        content,
        type
      });
      
      return this;
    }
  
    /**
     * Notificar que el usuario está escribiendo o ha dejado de escribir
     * @param {boolean} isTyping - true si está escribiendo, false si no
     */
    setTyping(isTyping = true) {
      if (!this.isAuthenticated || !this.currentRoom) {
        return this;
      }
  
      this.socket.emit('typing', {
        roomId: this.currentRoom,
        isTyping
      });
      
      return this;
    }
  
    /**
     * Crear una nueva sala de chat mediante la API REST
     * @param {string} name - Nombre de la sala
     * @param {array} participantIds - Array de IDs de participantes
     * @returns {Promise} - Promise que resuelve con los datos de la sala creada
     */
    async createRoom(name, participantIds = []) {
      if (!this.isAuthenticated) {
        throw new Error('El usuario no está autenticado');
      }
  
      try {
        const response = await fetch(`${this.serverUrl}/rooms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            creatorId: this.userId,
            creatorName: this.userName,
            participantIds
          }),
        });
  
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Error al crear la sala');
        }
  
        return await response.json();
      } catch (error) {
        this.callbacks.onError(error);
        throw error;
      }
    }
  
    /**
     * Obtener lista de salas disponibles
     * @returns {Promise} - Promise que resuelve con la lista de salas
     */
    async getRooms() {
      try {
        const response = await fetch(`${this.serverUrl}/rooms`);
        
        if (!response.ok) {
          throw new Error('Error al obtener las salas');
        }
        
        return await response.json();
      } catch (error) {
        this.callbacks.onError(error);
        throw error;
      }
    }
  
    /**
     * Obtener historial de mensajes de una sala
     * @param {string} roomId - ID de la sala
     * @returns {Promise} - Promise que resuelve con la lista de mensajes
     */
    async getRoomMessages(roomId) {
      try {
        const response = await fetch(`${this.serverUrl}/rooms/${roomId}/messages`);
        
        if (!response.ok) {
          throw new Error('Error al obtener los mensajes');
        }
        
        return await response.json();
      } catch (error) {
        this.callbacks.onError(error);
        throw error;
      }
    }
  
    /**
     * Desconectarse del servidor
     */
    disconnect() {
      if (this.socket) {
        this.socket.disconnect();
      }
      
      this.isConnected = false;
      this.isAuthenticated = false;
      this.currentRoom = null;
      
      return this;
    }
  
    /**
     * Registrar callbacks para eventos
     * @param {string} event - Nombre del evento
     * @param {function} callback - Función de callback
     */
    on(event, callback) {
      if (this.callbacks.hasOwnProperty(event)) {
        this.callbacks[event] = callback;
      } else {
        console.warn(`Evento desconocido: ${event}`);
      }
      
      return this;
    }
  }
  
  // Exportar para uso en módulos ES o CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatClient;
  } else {
    window.ChatClient = ChatClient;
  }