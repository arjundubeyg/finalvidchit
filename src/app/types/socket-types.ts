import { Socket } from 'socket.io-client';

export interface WebRTCPeer {
  peer: RTCPeerConnection | null;
  type: 'p1' | 'p2' | null;
  remoteSocket: string | null;
  roomId: string | null;
}

export interface MessageEvent {
  input: string;
  type: 'p1' | 'p2';
}