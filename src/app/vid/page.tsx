'use client';

import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { WebRTCPeer, MessageEvent } from '../types/socket-types';

const VideoChatComponent: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [webrtcState, setWebrtcState] = useState<WebRTCPeer>({
    peer: null,
    type: null,
    remoteSocket: null,
    roomId: null
  });
  const [messages, setMessages] = useState<string[]>([]);
  const [inputMessage, setInputMessage] = useState<string>('');
  const [isConnected, setIsConnected] = useState(false);

  const myVideoRef = useRef<HTMLVideoElement>(null);
  const strangerVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Initialize socket connection
    const newSocket = io('https://server-vid-chat.onrender.com', {
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });
    setSocket(newSocket);

    // Socket event handlers
    newSocket.on('connect', () => {
      setIsConnected(true);
      newSocket.emit('start', (person: 'p1' | 'p2') => {
        setWebrtcState(prev => ({ ...prev, type: person }));
      });
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('disconnected', () => {
      window.location.href = '/?disconnect';
    });

    newSocket.on('roomid', (id: string) => {
      setWebrtcState(prev => ({ ...prev, roomId: id }));
    });

    newSocket.on('remote-socket', (id: string) => {
      setupWebRTC(newSocket, id);
    });

    newSocket.on('get-message', handleIncomingMessage);
    newSocket.on('sdp:reply', handleSdpReply);
    newSocket.on('ice:reply', handleIceCandidate);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const setupWebRTC = (newSocket: Socket, remoteSocketId: string) => {
    const peerConnection = new RTCPeerConnection();
    
    setWebrtcState(prev => ({
      ...prev, 
      peer: peerConnection, 
      remoteSocket: remoteSocketId 
    }));

    startMediaCapture(peerConnection);

    peerConnection.onnegotiationneeded = async () => {
      if (webrtcState.type === 'p1') {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        newSocket.emit('sdp:send', { sdp: peerConnection.localDescription });
      }
    };

    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        newSocket.emit('ice:send', { 
          candidate: e.candidate, 
          to: remoteSocketId 
        });
      }
    };
  };

  const startMediaCapture = (peerConnection: RTCPeerConnection) => {
    navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .then(stream => {
        if (myVideoRef.current) {
          myVideoRef.current.srcObject = stream;
        }

        stream.getTracks().forEach(track => 
          peerConnection.addTrack(track, stream)
        );

        peerConnection.ontrack = (e) => {
          if (strangerVideoRef.current) {
            strangerVideoRef.current.srcObject = e.streams[0];
            strangerVideoRef.current.play();
          }
        };
      })
      .catch(console.error);
  };

  const handleSdpReply = async ({ sdp, from }: { sdp: RTCSessionDescriptionInit, from: string }) => {
    if (!webrtcState.peer) return;

    await webrtcState.peer.setRemoteDescription(new RTCSessionDescription(sdp));

    if (webrtcState.type === 'p2') {
      const answer = await webrtcState.peer.createAnswer();
      await webrtcState.peer.setLocalDescription(answer);
      socket?.emit('sdp:send', { sdp: webrtcState.peer.localDescription });
    }
  };

  const handleIceCandidate = async ({ candidate, from }: { candidate: RTCIceCandidateInit, from: string }) => {
    if (webrtcState.peer && candidate) {
      await webrtcState.peer.addIceCandidate(candidate);
    }
  };

  const handleIncomingMessage = (input: string, type: 'p1' | 'p2') => {
    setMessages(prev => [...prev, `Stranger: ${input}`]);
  };

  const sendMessage = () => {
    if (socket && inputMessage.trim()) {
      socket.emit('send-message', inputMessage, webrtcState.type, webrtcState.roomId);
      setMessages(prev => [...prev, `You: ${inputMessage}`]);
      setInputMessage('');
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col md:flex-row p-4">
      {/* Connection Status */}
      <div className="absolute top-4 right-4">
        <div 
          className={`w-4 h-4 rounded-full ${
            isConnected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
      </div>

      {/* Video Section */}
      <div className="w-full md:w-2/3 flex flex-col space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-black rounded-lg">
            <video 
              ref={myVideoRef} 
              className="w-full h-full object-cover rounded-lg" 
              autoPlay 
              muted 
            />
          </div>
          <div className="bg-black rounded-lg">
            <video 
              ref={strangerVideoRef} 
              className="w-full h-full object-cover rounded-lg" 
              autoPlay 
            />
          </div>
        </div>
      </div>

      {/* Chat Section */}
      <div className="w-full md:w-1/3 mt-4 md:mt-0 md:ml-4 bg-white rounded-lg shadow-md">
        <div className="h-[500px] overflow-y-auto p-4">
          {messages.map((msg, index) => (
            <div 
              key={index} 
              className={`mb-2 p-2 rounded ${
                msg.startsWith('You:') 
                  ? 'bg-blue-100 text-right' 
                  : 'bg-gray-100 text-left'
              }`}
            >
              {msg}
            </div>
          ))}
        </div>
        <div className="flex p-4">
          <input 
            type="text" 
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            className="flex-grow p-2 border rounded-l-lg" 
            placeholder="Type a message..."
          />
          <button 
            onClick={sendMessage}
            className="bg-blue-500 text-white p-2 rounded-r-lg hover:bg-blue-600"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoChatComponent;