"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io, Socket } from "socket.io-client";

const SERVER_URL = "https://server-vid-chat.onrender.com";

const Page: React.FC = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [type, setType] = useState<string>("");
  const [roomId, setRoomId] = useState<string>("");
  const [messages, setMessages] = useState<string[]>([]);
  const [inputMessage, setInputMessage] = useState<string>("");

  const myVideoRef = useRef<HTMLVideoElement>(null);
  const strangerVideoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteSocketRef = useRef<string>("");

  // Memoize callback functions to prevent unnecessary re-renders
  const handleSdpReply = useCallback(async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
    if (!peerRef.current || !socket) return;
    try {
      await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      if (type === "p2") {
        const ans = await peerRef.current.createAnswer();
        await peerRef.current.setLocalDescription(ans);
        socket.emit("sdp:send", { sdp: peerRef.current.localDescription });
      }
    } catch (error) {
      console.error("Error handling SDP reply:", error);
    }
  }, [type, socket]);

  const handleIceCandidate = useCallback(async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
    if (!peerRef.current || !candidate) return;
    try {
      await peerRef.current.addIceCandidate(candidate);
    } catch (error) {
      console.error("Error adding ICE candidate:", error);
    }
  }, []);

  const setupWebRTC = useCallback(async () => {
    if (type === "p1" && peerRef.current && socket) {
      try {
        const offer = await peerRef.current.createOffer();
        await peerRef.current.setLocalDescription(offer);
        socket.emit("sdp:send", { sdp: peerRef.current.localDescription });
      } catch (error) {
        console.error("WebRTC setup error:", error);
      }
    }
  }, [type, socket]);

  const startMediaCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      if (myVideoRef.current) myVideoRef.current.srcObject = stream;
      if (peerRef.current) {
        stream.getTracks().forEach((track) => peerRef.current?.addTrack(track, stream));
        peerRef.current.ontrack = (e) => {
          if (strangerVideoRef.current) {
            strangerVideoRef.current.srcObject = e.streams[0];
            strangerVideoRef.current.play();
          }
        };
      }
    } catch (ex) {
      console.error("Media capture error:", ex);
    }
  }, []);

  // Use a single useEffect for socket setup with minimal dependencies
  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    const handleStart = (personType: string) => setType(personType);
    const handleRemoteSocket = (id: string) => {
      remoteSocketRef.current = id;
      peerRef.current = new RTCPeerConnection();
      peerRef.current.onnegotiationneeded = setupWebRTC;
      peerRef.current.onicecandidate = (e) => {
        newSocket.emit("ice:send", { candidate: e.candidate, to: remoteSocketRef.current });
      };
      startMediaCapture();
    };

    newSocket.emit("start", handleStart);
    newSocket.on("remote-socket", handleRemoteSocket);
    newSocket.on("roomid", setRoomId);
    newSocket.on("get-message", (input: string) => setMessages((prev) => [...prev, `Stranger: ${input}`]));
    newSocket.on("sdp:reply", handleSdpReply);
    newSocket.on("ice:reply", handleIceCandidate);
    newSocket.on("disconnected", () => (window.location.href = "/?disconnect"));

    return () => {
      newSocket.disconnect();
    };
  }, []); // Empty dependency array to run only once

  const handleSendMessage = useCallback(() => {
    if (socket && inputMessage) {
      socket.emit("send-message", inputMessage, type, roomId);
      setMessages((prev) => [...prev, `You: ${inputMessage}`]);
      setInputMessage("");
    }
  }, [socket, inputMessage, type, roomId]);

  return (
    <div className="flex flex-col min-h-screen bg-gray-100 p-4">
      <div className="flex-grow grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Video Containers */}
        <div className="bg-black rounded-lg flex items-center justify-center">
          <video ref={myVideoRef} autoPlay muted className="max-w-full max-h-full" />
        </div>
        <div className="bg-black rounded-lg flex items-center justify-center">
          <video ref={strangerVideoRef} autoPlay className="max-w-full max-h-full" />
        </div>

        {/* Chat Section */}
        <div className="col-span-full bg-white rounded-lg shadow-md p-4">
          <div className="h-64 overflow-y-auto mb-4">
            {messages.map((msg, index) => (
              <div key={index} className="py-1">
                {msg}
              </div>
            ))}
          </div>
          <div className="flex">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              className="flex-grow p-2 border rounded-l-lg"
              placeholder="Type a message..."
            />
            <button 
              onClick={handleSendMessage} 
              className="bg-blue-500 text-white px-4 py-2 rounded-r-lg hover:bg-blue-600"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Page;