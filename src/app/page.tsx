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
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // State
  const [remoteSocketId, setRemoteSocketId] = useState<string | null>(null);
  const [userType, setUserType] = useState<'p1' | 'p2' | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'finding-peer' | 'connected'>('disconnected');
  const [messages, setMessages] = useState<Array<{sender: string, text: string}>>([]);
  const [error, setError] = useState<string | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [peerConnected, setPeerConnected] = useState(false);

  // Cleanup all resources
  const cleanup = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }

    if (myVideoRef.current) myVideoRef.current.srcObject = null;
    if (strangerVideoRef.current) strangerVideoRef.current.srcObject = null;

    setRemoteSocketId(null);
    setPeerConnected(false);
  };

  // Get user media immediately on load
  const getUserMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 22050,
        },
        video: {
          width: { ideal: 320, max: 480 },
          height: { ideal: 240, max: 360 },
          frameRate: { ideal: 10, max: 15 },
          facingMode: 'user'
        }
      });
      
      streamRef.current = stream;
      
      if (myVideoRef.current) {
        myVideoRef.current.srcObject = stream;
      }
      
      return stream;
    } catch (err) {
      console.error('Media access error:', err);
      setError('Camera/microphone access denied. Please allow permissions and refresh.');
      throw err;
    }
  };

  // Create peer connection
  const createPeerConnection = async () => {
    if (!streamRef.current) {
      await getUserMedia();
    }

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      iceTransportPolicy: 'all'
    });

    // Add local stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        if (streamRef.current) {
          peer.addTrack(track, streamRef.current);
        }
      });
    }

    // Handle remote stream
    peer.ontrack = (event) => {
      console.log('Received remote stream');
      if (strangerVideoRef.current && event.streams[0]) {
        strangerVideoRef.current.srcObject = event.streams[0];
        setPeerConnected(true);
      }
    };

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && remoteSocketId) {
        console.log('Sending ICE candidate');
        socketRef.current.emit('ice:send', { 
          candidate: event.candidate, 
          to: remoteSocketId 
        });
      }
    };

    // Handle connection state changes
    peer.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', peer.iceConnectionState);
      
      if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
        setPeerConnected(true);
        setError(null);
      } else if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
        setPeerConnected(false);
        setError('Video connection lost. Trying to reconnect...');
      }
    };

    peerRef.current = peer;
    return peer;
  };

  // Handle WebRTC negotiation
  const handleNegotiation = async () => {
    if (!peerRef.current || !socketRef.current) return;

    try {
      if (userType === 'p1') {
        console.log('Creating offer (p1)');
        const offer = await peerRef.current.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await peerRef.current.setLocalDescription(offer);
        socketRef.current.emit('sdp:send', { sdp: peerRef.current.localDescription });
      }
    } catch (err) {
      console.error('Negotiation error:', err);
      setError('Connection setup failed');
    }
  };

  // Initialize socket connection
  useEffect(() => {
    // Initialize media first
    getUserMedia().then(() => {
      console.log('Media initialized');
    }).catch(() => {
      // Error already handled in getUserMedia
    });

    const socket = io('https://server-vid-chat.onrender.com', {
      transports: ['websocket'],
      timeout: 10000,
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 2000
    });

    socketRef.current = socket;
    setConnectionStatus('connecting');

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      setConnectionStatus('finding-peer');
      setError(null);
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket disconnected:', reason);
      setConnectionStatus('disconnected');
      setPeerConnected(false);
      
      if (reason === 'io server disconnect') {
        setError('Server disconnected. Refreshing page...');
        setTimeout(() => window.location.reload(), 2000);
      } else {
        setError('Connection lost. Reconnecting...');
      }
    });

    socket.on('connect_error', (err) => {
      console.error('Connection error:', err);
      setConnectionStatus('disconnected');
      setError('Cannot connect to server. Check your internet connection.');
    });

    socket.on('remote-socket', async (id) => {
      console.log('Remote socket connected:', id);
      setRemoteSocketId(id);
      setConnectionStatus('connected');
      
      // Create peer connection when we have a remote peer
      try {
        await createPeerConnection();
        // Start negotiation after a short delay
        setTimeout(handleNegotiation, 1000);
      } catch (err) {
        setError('Failed to initialize video connection');
      }
    });

    socket.on('sdp:reply', async ({ sdp }: SDPData) => {
      console.log('Received SDP reply');
      if (!peerRef.current) return;

      try {
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        
        if (userType === 'p2') {
          console.log('Creating answer (p2)');
          const answer = await peerRef.current.createAnswer();
          await peerRef.current.setLocalDescription(answer);
          socket.emit('sdp:send', { sdp: peerRef.current.localDescription });
        }
      } catch (err) {
        console.error('SDP handling error:', err);
        setError('Video connection failed');
      }
    });

    socket.on('ice:reply', async ({ candidate }: IceCandidateData) => {
      console.log('Received ICE candidate');
      if (peerRef.current && candidate) {
        try {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('ICE candidate error:', err);
        }
      }
    });

    socket.on('roomid', (id) => {
      console.log('Room ID:', id);
      setRoomId(id);
    });

    socket.on('get-message', (text) => {
      setMessages(prev => [...prev, { sender: 'Stranger', text }]);
    });

    socket.on('disconnected', () => {
      console.log('Peer disconnected');
      cleanup();
      setConnectionStatus('finding-peer');
      setPeerConnected(false);
      setError('Partner left. Looking for new connection...');
    });

    // Start the connection process
    socket.emit('start', (person: 'p1' | 'p2') => {
      console.log('User type assigned:', person);
      setUserType(person);
    });

    return () => {
      console.log('Cleaning up component');
      socket.disconnect();
      cleanup();
    };
  }, []);

  // Send message
  const handleSendMessage = () => {
    const text = inputRef.current?.value.trim();
    if (!text || !socketRef.current || !roomId) return;

    socketRef.current.emit('send-message', text, userType, roomId);
    setMessages(prev => [...prev, { sender: 'You', text }]);
    if (inputRef.current) inputRef.current.value = '';
  };

  // Toggle video
  const toggleVideo = () => {
    if (streamRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideoEnabled(videoTrack.enabled);
      }
    }
  };

  // Get status message
  const getStatusMessage = () => {
    switch (connectionStatus) {
      case 'disconnected':
        return 'Disconnected';
      case 'connecting':
        return 'Connecting to server...';
      case 'finding-peer':
        return 'Looking for someone to chat with...';
      case 'connected':
        return peerConnected ? 'Connected!' : 'Setting up video...';
      default:
        return 'Unknown status';
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      {/* Error Display */}
      {error && (
        <div className="bg-red-600 p-3 rounded-md mb-4 flex justify-between items-center">
          <span>{error}</span>
          <button 
            onClick={() => window.location.reload()}
            className="bg-white text-red-600 px-3 py-1 rounded-md text-sm hover:bg-gray-100"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Video Section */}
      <div className="relative mb-4 h-[50vh] bg-black rounded-lg overflow-hidden">
        {/* Remote Video */}
        <video
          ref={strangerVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />
        
        {/* Local Video (Picture-in-Picture) */}
        <div className="absolute top-4 right-4 w-24 h-18 bg-gray-800 rounded-lg overflow-hidden border-2 border-blue-500">
          <video
            ref={myVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
          {!videoEnabled && (
            <div className="absolute inset-0 bg-gray-600 flex items-center justify-center">
              <span className="text-xs">Video Off</span>
            </div>
          )}
        </div>

        {/* Connection Status Overlay */}
        {!peerConnected && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p className="text-lg">{getStatusMessage()}</p>
              {connectionStatus === 'finding-peer' && (
                <p className="text-sm text-gray-400 mt-2">This may take a moment...</p>
              )}
            </div>
          </div>
        )}

        {/* Controls */}
        {peerConnected && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-4">
            <button
              onClick={toggleVideo}
              className={`px-4 py-2 rounded-md transition-colors ${
                videoEnabled ? 'bg-blue-600 hover:bg-blue-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {videoEnabled ? '📹 Video' : '📹 Off'}
            </button>
          </div>
        )}
      </div>

      {/* Chat Section */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="h-32 overflow-y-auto mb-4 space-y-2">
          {messages.map((msg, index) => (
            <div 
              key={index} 
              className={`p-2 rounded-lg max-w-xs ${msg.sender === 'You' 
                ? 'bg-blue-600 ml-auto' 
                : 'bg-gray-700'}`}
            >
              <span className="font-bold">{msg.sender}: </span>
              <span>{msg.text}</span>
            </div>
          ))}
          {messages.length === 0 && (
            <div className="text-center text-gray-400 py-4">
              {peerConnected ? 'Start chatting!' : 'Chat will be available once connected'}
            </div>
          )}
        </div>
        
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder={peerConnected ? "Type message..." : "Waiting for connection..."}
            className="flex-1 p-2 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
            disabled={!peerConnected}
          />
          <button
            onClick={handleSendMessage}
            disabled={!peerConnected}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-md disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="mt-4 text-center text-sm">
        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
          peerConnected ? 'bg-green-500' : 
          connectionStatus === 'connected' ? 'bg-yellow-500' :
          connectionStatus === 'connecting' || connectionStatus === 'finding-peer' ? 'bg-orange-500' : 'bg-red-500'
        }`}></span>
        {getStatusMessage()} {roomId && `• Room: ${roomId}`}
      </div>
    </div>
  );
};

export default VideoChat;