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
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [messages, setMessages] = useState<Array<{sender: string, text: string}>>([]);
  const [error, setError] = useState<string | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(true);

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
    setUserType(null);
    setConnectionStatus('disconnected');
  };

  // Get user media with reduced quality
  const getUserMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 22050, // Reduced sample rate
        },
        video: {
          width: { ideal: 480, max: 640 }, // Much lower resolution
          height: { ideal: 360, max: 480 },
          frameRate: { ideal: 15, max: 20 }, // Lower frame rate
          facingMode: 'user'
        }
      });
      
      streamRef.current = stream;
      
      if (myVideoRef.current) {
        myVideoRef.current.srcObject = stream;
      }
      
      return stream;
    } catch (err) {
      console.error('Error accessing media:', err);
      setError('Cannot access camera/microphone. Please check permissions.');
      throw err;
    }
  };

  // Create peer connection with optimized settings
  const createPeerConnection = () => {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    });

    // Handle remote stream
    peer.ontrack = (event) => {
      if (strangerVideoRef.current && event.streams[0]) {
        strangerVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && remoteSocketId) {
        socketRef.current.emit('ice:send', { 
          candidate: event.candidate, 
          to: remoteSocketId 
        });
      }
    };

    // Handle connection state changes
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
        setError('Connection lost. Please refresh.');
      }
    };

    return peer;
  };

  // Initialize WebRTC connection
  const initializeWebRTC = async () => {
    if (!socketRef.current || !remoteSocketId) return;

    try {
      const stream = await getUserMedia();
      const peer = createPeerConnection();
      peerRef.current = peer;

      // Add tracks with reduced bitrate
      stream.getTracks().forEach(track => {
        const sender = peer.addTrack(track, stream);
        
        // Reduce bitrate for video tracks
        if (track.kind === 'video') {
          const params = sender.getParameters();
          if (params.encodings && params.encodings.length > 0) {
            params.encodings[0].maxBitrate = 150000; // 150 kbps max
          }
          sender.setParameters(params);
        }
      });

      // Create offer if user is p1
      if (userType === 'p1') {
        const offer = await peer.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });
        await peer.setLocalDescription(offer);
        socketRef.current.emit('sdp:send', { sdp: peer.localDescription });
      }

    } catch (err) {
      console.error('WebRTC initialization failed:', err);
      setError('Failed to initialize video connection.');
    }
  };

  // Initialize socket connection
  useEffect(() => {
    const socket = io('https://server-vid-chat.onrender.com', {
      transports: ['websocket'],
      timeout: 20000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnectionStatus('connected');
      setError(null);
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
      setError('Disconnected from server');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('disconnected');
      setError('Connection failed');
    });

    socket.on('remote-socket', (id) => {
      setRemoteSocketId(id);
    });

    socket.on('sdp:reply', async ({ sdp }: SDPData) => {
      if (!peerRef.current) return;

      try {
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        
        if (userType === 'p2') {
          const answer = await peerRef.current.createAnswer();
          await peerRef.current.setLocalDescription(answer);
          socket.emit('sdp:send', { sdp: peerRef.current.localDescription });
        }
      } catch (err) {
        console.error('SDP error:', err);
        setError('Connection setup failed');
      }
    });

    socket.on('ice:reply', async ({ candidate }: IceCandidateData) => {
      if (peerRef.current && candidate) {
        try {
          await peerRef.current.addIceCandidate(candidate);
        } catch (err) {
          console.error('ICE candidate error:', err);
        }
      }
    });

    socket.on('roomid', setRoomId);

    socket.on('get-message', (text) => {
      setMessages(prev => [...prev, { sender: 'Stranger', text }]);
    });

    socket.on('disconnected', () => {
      cleanup();
      setError('Partner disconnected');
    });

    // Start connection
    socket.emit('start', (person: 'p1' | 'p2') => {
      setUserType(person);
      setConnectionStatus('connecting');
    });

    return () => {
      socket.disconnect();
      cleanup();
    };
  }, []);

  // Initialize WebRTC when we have remote socket and user type
  useEffect(() => {
    if (remoteSocketId && userType && connectionStatus === 'connected') {
      initializeWebRTC();
    }
  }, [remoteSocketId, userType, connectionStatus]);

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
        {connectionStatus !== 'connected' && (
          <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p>{connectionStatus === 'connecting' ? 'Connecting...' : 'Waiting for connection'}</p>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-4">
          <button
            onClick={toggleVideo}
            className={`px-4 py-2 rounded-md ${videoEnabled ? 'bg-blue-600' : 'bg-red-600'}`}
          >
            {videoEnabled ? 'Video On' : 'Video Off'}
          </button>
        </div>
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
              Start chatting!
            </div>
          )}
        </div>
        
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Type message..."
            className="flex-1 p-2 bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
            disabled={connectionStatus !== 'connected'}
          />
          <button
            onClick={handleSendMessage}
            disabled={connectionStatus !== 'connected'}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-md disabled:bg-gray-600"
          >
            Send
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="mt-4 text-center text-sm">
        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${
          connectionStatus === 'connected' ? 'bg-green-500' : 
          connectionStatus === 'connecting' ? 'bg-yellow-500' : 'bg-red-500'
        }`}></span>
        {connectionStatus} {roomId && `• Room: ${roomId}`}
      </div>
    </div>
  );
};

export default VideoChat;