"use client"
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SDPData {
  sdp: RTCSessionDescription;
  from: string;
}

interface IceCandidateData {
  candidate: RTCIceCandidate | null;
  from: string;
}

const VideoChat = () => {
  // Refs
  const myVideoRef = useRef<HTMLVideoElement>(null);
  const strangerVideoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatWrapperRef = useRef<HTMLDivElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // State
  const [remoteSocketId, setRemoteSocketId] = useState<string | null>(null);
  const [userType, setUserType] = useState<'p1' | 'p2' | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [messages, setMessages] = useState<Array<{sender: string, text: string}>>([]);
  const [error, setError] = useState<string | null>(null);

  // Debug logging
  const debugLog = (message: string, data?: any) => {
    console.log(`[DEBUG] ${message}`, data || '');
  };

  // Cleanup all resources
  const cleanup = () => {
    debugLog('Cleaning up resources');
    
    // Stop all media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        debugLog('Stopped track:', track.kind);
      });
      streamRef.current = null;
    }

    // Close peer connection
    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }

    // Clear video elements
    if (myVideoRef.current) myVideoRef.current.srcObject = null;
    if (strangerVideoRef.current) strangerVideoRef.current.srcObject = null;

    setRemoteSocketId(null);
    setUserType(null);
    setConnectionStatus('disconnected');
  };

  // Initialize socket connection
  useEffect(() => {
    const initializeSocket = async () => {
      cleanup();
      setConnectionStatus('connecting');
      
      try {
        const socket = io('https://server-vid-chat.onrender.com', {
          transports: ['websocket'],
          reconnectionAttempts: 5,
          reconnectionDelay: 1000,
        });

        socketRef.current = socket;

        socket.on('connect', () => {
          debugLog('Socket connected', socket.id);
          setConnectionStatus('connected');
        });

        socket.on('disconnect', () => {
          debugLog('Socket disconnected');
          setConnectionStatus('disconnected');
          setError('Disconnected from server. Please refresh.');
        });

        socket.on('connect_error', (err) => {
          debugLog('Connection error:', err);
          setConnectionStatus('disconnected');
          setError('Connection failed. Please check your network.');
        });

        socket.on('remote-socket', (id) => {
          debugLog('Received remote socket ID:', id);
          setRemoteSocketId(id);
          initializePeerConnection();
        });

        socket.on('sdp:reply', async ({ sdp, from }: SDPData) => {
          debugLog('Received SDP reply from:', from);
          if (!peerRef.current) return;

          try {
            await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
            debugLog('Set remote description successfully');

            if (userType === 'p2') {
              const answer = await peerRef.current.createAnswer();
              await peerRef.current.setLocalDescription(answer);
              socket.emit('sdp:send', { sdp: peerRef.current.localDescription });
              debugLog('Sent answer SDP');
            }
          } catch (err) {
            debugLog('Error handling SDP reply:', err);
            setError('Failed to establish connection. Please try again.');
          }
        });

        socket.on('ice:reply', async ({ candidate, from }: IceCandidateData) => {
          debugLog('Received ICE candidate from:', from);
          if (!peerRef.current || !candidate) return;

          try {
            await peerRef.current.addIceCandidate(candidate);
            debugLog('Added ICE candidate successfully');
          } catch (err) {
            debugLog('Error adding ICE candidate:', err);
          }
        });

        socket.on('roomid', (id) => {
          debugLog('Received room ID:', id);
          setRoomId(id);
        });

        socket.on('get-message', (text, senderType) => {
          debugLog('Received message:', text);
          setMessages(prev => [...prev, { sender: 'Stranger', text }]);
        });

        socket.on('disconnected', () => {
          debugLog('Server disconnected');
          window.location.href = `/?disconnect`;
        });

        // Start the connection process
        socket.emit('start', (person: 'p1' | 'p2') => {
          debugLog('User type assigned:', person);
          setUserType(person);
        });

      } catch (err) {
        debugLog('Socket initialization error:', err);
        setConnectionStatus('disconnected');
        setError('Failed to connect. Please refresh the page.');
      }
    };

    initializeSocket();

    return () => {
      debugLog('Component unmounting - cleaning up');
      if (socketRef.current) socketRef.current.disconnect();
      cleanup();
    };
  }, []);

  // Initialize media stream and peer connection
  const initializePeerConnection = async () => {
    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });
      streamRef.current = stream;

      if (myVideoRef.current) {
        myVideoRef.current.srcObject = stream;
        myVideoRef.current.play().catch(err => debugLog('Error playing local video:', err));
      }

      // Create peer connection
      const peer = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' }
        ],
        iceTransportPolicy: 'all'
      });
      peerRef.current = peer;

      // Add local tracks
      stream.getTracks().forEach(track => {
        peer.addTrack(track, stream);
        debugLog('Added local track:', track.kind);
      });

      // Handle remote stream
      peer.ontrack = (event) => {
        debugLog('Received remote tracks:', event.streams.length);
        if (strangerVideoRef.current && event.streams.length > 0) {
          strangerVideoRef.current.srcObject = event.streams[0];
          strangerVideoRef.current.play().catch(err => debugLog('Error playing remote video:', err));
        }
      };

      // ICE candidate handling
      peer.onicecandidate = (event) => {
        if (event.candidate && remoteSocketId) {
          socketRef.current?.emit('ice:send', { candidate: event.candidate, to: remoteSocketId });
          debugLog('Sent ICE candidate');
        }
      };

      peer.oniceconnectionstatechange = () => {
        debugLog('ICE connection state:', peer.iceConnectionState);
        if (peer.iceConnectionState === 'failed') {
          setError('Connection failed. Please try again.');
        }
      };

      peer.onnegotiationneeded = async () => {
        debugLog('Negotiation needed');
        if (userType === 'p1') {
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socketRef.current?.emit('sdp:send', { sdp: peer.localDescription });
            debugLog('Sent offer SDP');
          } catch (err) {
            debugLog('Error creating offer:', err);
            setError('Failed to start connection. Please refresh.');
          }
        }
      };

    } catch (err) {
      debugLog('Error initializing peer connection:', err);
      setError('Failed to access camera/microphone. Please check permissions.');
      cleanup();
    }
  };

  // Handle send message
  const handleSendMessage = () => {
    const text = inputRef.current?.value.trim();
    if (!text || !socketRef.current || !userType || !roomId) return;

    socketRef.current.emit('send-message', text, userType, roomId);
    setMessages(prev => [...prev, { sender: 'You', text }]);
    if (inputRef.current) inputRef.current.value = '';
  };

  // Handle Enter key press
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSendMessage();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      {/* Error Display */}
      {error && (
        <div className="bg-red-600 p-3 rounded-md mb-4 flex justify-between items-center">
          <span>{error}</span>
          <button 
            onClick={() => window.location.reload()}
            className="bg-white text-red-600 px-3 py-1 rounded-md text-sm"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Video Section */}
      <div className="flex flex-col md:flex-row gap-4 mb-4 h-[70vh] relative">
        {/* Stranger Video */}
        <div className="flex-1 bg-black rounded-lg overflow-hidden relative">
          <video
            ref={strangerVideoRef}
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-cover"
          />
          
          {connectionStatus !== 'connected' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-70">
              <div className="text-center">
                <div className={`spinner border-4 ${connectionStatus === 'connecting' ? 'border-blue-500 border-t-transparent animate-spin' : 'border-red-500'} rounded-full w-12 h-12 mx-auto mb-4`}></div>
                <p>
                  {connectionStatus === 'connecting' 
                    ? 'Connecting to server...' 
                    : 'Waiting for connection...'}
                </p>
                {!remoteSocketId && (
                  <p className="text-sm mt-2">Looking for another user...</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* User Video (Small Circle) */}
        <div className="absolute bottom-4 right-4 w-24 h-24 md:w-32 md:h-32 rounded-full border-4 border-blue-500 overflow-hidden bg-black z-10">
          <video
            ref={myVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        </div>
      </div>

      {/* Chat Section */}
      <div className="bg-gray-800 rounded-lg shadow-lg p-4">
        <div className="chat-holder h-48 overflow-y-auto mb-4 space-y-2">
          {messages.map((msg, index) => (
            <div 
              key={index} 
              className={`p-2 rounded-lg max-w-xs md:max-w-md ${msg.sender === 'You' 
                ? 'bg-blue-600 ml-auto' 
                : 'bg-gray-700 mr-auto'}`}
            >
              <b>{msg.sender}: </b>
              <span>{msg.text}</span>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-center text-gray-400 py-8">
              No messages yet. Say hello to your partner!
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Type your message..."
            className="flex-1 p-2 bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyPress={handleKeyPress}
            disabled={connectionStatus !== 'connected'}
          />
          <button
            onClick={handleSendMessage}
            disabled={connectionStatus !== 'connected'}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>

      {/* Status Indicator */}
      <div className="mt-4 text-center">
        <div className="inline-flex items-center">
          <span className={`w-3 h-3 rounded-full mr-2 ${
            connectionStatus === 'connected' ? 'bg-green-500' : 
            connectionStatus === 'connecting' ? 'bg-yellow-500' : 'bg-red-500'
          }`}></span>
          <span className="capitalize">{connectionStatus}</span>
          {roomId && (
            <span className="ml-4 text-sm text-gray-400">Room: {roomId}</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoChat;