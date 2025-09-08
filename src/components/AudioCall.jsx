// components/AudioCall.jsx
import { useEffect, useRef, useState } from "react";
import socketConnection from "../utils/socketConnection";
import peerConfiguration from "../utils/peerConfiguration";
import ActionButtons from "./ActionButton";

// props: displayName, roomId, role ('teacher' | 'student')
const AudioCall = ({ displayName, roomId, role = "student" }) => {
  const [haveMedia, setHaveMedia] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState("Connecting...");

  // Student: single RTCPeerConnection
  const pcRef = useRef(null);
  // Teacher: map of RTCPeerConnections keyed by student socket id
  const pcsRef = useRef({});
  // Socket ref
  const socketRef = useRef(null);
  // Single audio element used for either: student plays teacher stream OR teacher plays mixed student stream
  const audioRef = useRef(null);

  // Shared stream for teacher to combine all student tracks into one element (teacher hears everyone)
  const sharedStreamRef = useRef(new MediaStream());
  // Map to track which tracks came from which student (for removal on disconnect)
  const studentTracksRef = useRef({}); // { [studentSocketId]: MediaStreamTrack[] }

  // Map for forwarded senders: trackId -> { [toStudentId]: RTCRtpSender }
  const forwardedSendersRef = useRef({});

  useEffect(() => {
    let mounted = true;

    // Forward a track to a particular student's pc (teacher -> that student)
    const forwardTrackToPc = (track, fromStudentId, toStudentId) => {
      try {
        const pc = pcsRef.current[toStudentId];
        if (!pc) return null;
        forwardedSendersRef.current[track.id] = forwardedSendersRef.current[track.id] || {};
        if (forwardedSendersRef.current[track.id][toStudentId]) {
          // already forwarded
          return forwardedSendersRef.current[track.id][toStudentId];
        }
        // Add track to the PC (wrap in a MediaStream)
        const sender = pc.addTrack(track, new MediaStream([track]));
        forwardedSendersRef.current[track.id][toStudentId] = sender;
        console.log(`Teacher: forwarded track ${track.id} from ${fromStudentId} -> pc[${toStudentId}]`);
        return sender;
      } catch (e) {
        console.warn("forwardTrackToPc error", e);
        return null;
      }
    };

    // Forward a track to all students except the origin
    const forwardTrackToAllExcept = (fromStudentId, track) => {
      Object.keys(pcsRef.current).forEach((targetId) => {
        if (targetId === fromStudentId) return;
        forwardTrackToPc(track, fromStudentId, targetId);
      });
    };

    // Remove all forwarded senders for a specific track
    const removeForwardedTrack = (track) => {
      try {
        const map = forwardedSendersRef.current[track.id] || {};
        Object.entries(map).forEach(([toId, sender]) => {
          try {
            const pc = pcsRef.current[toId];
            if (pc && sender) {
              pc.removeTrack(sender);
              console.log(`Teacher: removed forwarded sender for track ${track.id} from pc[${toId}]`);
            }
          } catch (e) {
            // swallow
          }
        });
        delete forwardedSendersRef.current[track.id];
      } catch (e) {
        console.warn("removeForwardedTrack error", e);
      }
    };

    // Remove all tracks for a student: from sharedStream and forwarded copies
    const removeStudentTracks = (id) => {
      try {
        const tracks = studentTracksRef.current[id];
        if (!tracks || !sharedStreamRef.current) return;
        tracks.forEach((t) => {
          try {
            // remove from teacher's shared stream
            const existing = sharedStreamRef.current.getTracks().find((x) => x.id === t.id);
            if (existing) sharedStreamRef.current.removeTrack(existing);
          } catch (e) {}
          // remove forwarded copies
          try {
            removeForwardedTrack(t);
          } catch (e) {}
          // stop track if desired (not strictly necessary)
          try { t.stop?.(); } catch (e) {}
        });
        delete studentTracksRef.current[id];
        // reconnect teacher audio element to updated shared stream
        try {
          if (audioRef.current) audioRef.current.srcObject = sharedStreamRef.current;
        } catch (e) {}
        console.log("Teacher: removed studentTracks for", id);
      } catch (e) {
        console.warn("removeStudentTracks error", e);
      }
    };

    const setup = async () => {
      try {
        console.log("AudioCall setup:", { displayName, roomId, role });
        setConnectionStatus("Getting microphone access...");

        // 1. Get media first
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleSize: 16,
            channelCount: 1,
            sampleRate: 16000,
          },
          video: false,
        });

        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        setLocalStream(stream);
        setHaveMedia(true);
        setAudioEnabled(true);
        setConnectionStatus("Connecting to server...");

        // 2. Setup socket connection
        const socket = socketConnection(displayName, roomId);
        socketRef.current = socket;

        // 3. Setup ALL event handlers BEFORE any operations
        socket.on("connect", () => {
          console.log("socket connected", socket.id);
        });
        
        socket.on("disconnect", (reason) => {
          console.log("socket disconnected", reason);
          setConnectionStatus("Disconnected");
        });

        // 4. Wait for socket connection
        await new Promise((resolve, reject) => {
          if (socket.connected) {
            resolve();
          } else {
            socket.on("connect", resolve);
            socket.on("connect_error", reject);
            setTimeout(() => reject(new Error("Connection timeout")), 10000);
          }
        });

        setConnectionStatus("Joining room...");

        // 5. Wait for room join/create with proper acknowledgment
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Room operation timeout")), 10000);
          
          if (role === "teacher") {
            socket.emit("createRoom", { roomId }, (response) => {
              clearTimeout(timeout);
              if (response && response.success !== false) {
                console.log("Room created successfully");
                resolve();
              } else {
                reject(new Error("Failed to create room"));
              }
            });
          } else {
            socket.emit("joinRoom", { roomId }, (response) => {
              clearTimeout(timeout);
              if (response && response.success !== false) {
                console.log("Room joined successfully");
                resolve();
              } else {
                reject(new Error("Failed to join room"));
              }
            });
          }
        });

        setConnectionStatus("Setting up audio connection...");

        // 6. Now setup WebRTC - all handlers are in place, room is confirmed
        if (role !== "teacher") {
          // --- STUDENT FLOW ---
          const pc = new RTCPeerConnection(peerConfiguration);
          pcRef.current = pc;

          // Setup all PC event handlers before any operations
          pc.ontrack = (ev) => {
            try {
              console.log("student: ontrack", ev);
              const el = audioRef.current;
              if (!el) return;

              // prefer attached stream
              if (ev.streams && ev.streams[0]) {
                el.srcObject = ev.streams[0];
              } else {
                if (!el.srcObject) el.srcObject = new MediaStream();
                try {
                  el.srcObject.addTrack(ev.track);
                } catch (e) {
                  console.warn("student addTrack fallback:", e);
                }
              }

              // robust play attempt
              el.play().catch(async (err) => {
                console.warn("student audio autoplay blocked or failed:", err);
                try {
                  el.muted = true;
                  await el.play();
                  setTimeout(() => { try { el.muted = false; } catch {} }, 250);
                } catch (e) {
                  console.warn("student muted autoplay also failed", e);
                }
              });
            } catch (e) {
              console.warn("student ontrack overall error", e);
            }
          };

          pc.onicecandidate = (event) => {
            if (event.candidate && socketRef.current) {
              socketRef.current.emit("sendIceCandidateToSignalingServer", {
                offererSocketId: socketRef.current.id,
                candidate: event.candidate,
                fromSocketId: socketRef.current.id,
              });
            }
          };

          pc.onconnectionstatechange = () => {
            console.log("Student PC connection state:", pc.connectionState);
            if (pc.connectionState === "connected") {
              setConnectionStatus("Connected");
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
              setConnectionStatus("Connection failed");
            }
          };

          // Setup socket handlers for student
          socket.on("answerResponse", async (entireOffer) => {
            if (!pcRef.current) return;
            if (entireOffer.answer) {
              try {
                await pcRef.current.setRemoteDescription(entireOffer.answer);
                console.log("student: setRemoteDescription(answer) done");
              } catch (err) {
                console.warn("student setRemoteDescription error:", err);
              }
            }
          });

          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload || !payload.candidate) return;
            if (pcRef.current) {
              try {
                await pcRef.current.addIceCandidate(
                  new RTCIceCandidate(payload.candidate)
                );
              } catch (e) {
                console.warn("student addIceCandidate err", e);
              }
            }
          });

          socket.on("availableOffers", (offers) => {
            const myOffer = offers.find(
              (o) => o.offererSocketId === socketRef.current.id && o.answer
            );
            if (myOffer && myOffer.answer && pcRef.current && !pcRef.current.remoteDescription) {
              pcRef.current.setRemoteDescription(myOffer.answer).catch((e) => {
                console.warn("student availableOffers setRemoteDescription err", e);
              });
            }
          });

          // Add local tracks to PC
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));

          // Now create and send offer (everything is ready)
          if (pc.signalingState === "stable") {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              
              // Wait for offer to be sent successfully
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Offer send timeout")), 10000);
                socket.emit("newOffer", offer, (ack) => {
                  clearTimeout(timeout);
                  console.log("student: offer sent ack", ack);
                  resolve();
                });
              });
              
              setConnectionStatus("Waiting for teacher response...");
            } catch (err) {
              console.warn("student createOffer error", err);
              setConnectionStatus("Failed to send offer");
            }
          }
        } else {
          // --- TEACHER FLOW ---
          setConnectionStatus("Ready - waiting for students...");

          // helper to create a pc for a particular student socket id
          const createPcForStudent = (studentSocketId) => {
            if (pcsRef.current[studentSocketId])
              return pcsRef.current[studentSocketId];

            const pc = new RTCPeerConnection(peerConfiguration);
            pcsRef.current[studentSocketId] = pc;

            // add teacher's local mic tracks to each pc (so students hear teacher)
            stream.getTracks().forEach((track) => {
              try {
                // avoid adding duplicates
                const exists = pc.getSenders().some((s) => s.track && s.track.id === track.id);
                if (!exists) pc.addTrack(track, stream);
              } catch (e) {
                console.warn("teacher addTrack (teacher mic) failed for", studentSocketId, e);
              }
            });

            // If there are already student tracks collected (other students), forward them into this new PC
            Object.entries(studentTracksRef.current).forEach(([fromId, tracks]) => {
              if (fromId === studentSocketId) return;
              (tracks || []).forEach((t) => {
                try {
                  forwardedSendersRef.current[t.id] = forwardedSendersRef.current[t.id] || {};
                  if (!forwardedSendersRef.current[t.id][studentSocketId]) {
                    const sender = pc.addTrack(t, new MediaStream([t]));
                    forwardedSendersRef.current[t.id][studentSocketId] = sender;
                    console.log(`Teacher: forwarded existing track ${t.id} from ${fromId} -> new pc[${studentSocketId}]`);
                  }
                } catch (e) {
                  console.warn("teacher forward existing track error", e);
                }
              });
            });

            pc.ontrack = (ev) => {
              console.log("teacher: ontrack from student", studentSocketId, ev);
              const shared = sharedStreamRef.current;

              // prefer full stream if provided
              if (ev.streams && ev.streams[0]) {
                ev.streams[0].getTracks().forEach((incomingTrack) => {
                  if (!shared.getTracks().find((t) => t.id === incomingTrack.id)) {
                    shared.addTrack(incomingTrack);
                    studentTracksRef.current[studentSocketId] =
                      studentTracksRef.current[studentSocketId] || [];
                    studentTracksRef.current[studentSocketId].push(incomingTrack);

                    // forward this incoming track to all other student PCs
                    forwardTrackToAllExcept(studentSocketId, incomingTrack);
                  }
                });
              } else {
                const t = ev.track;
                if (t && !shared.getTracks().find((x) => x.id === t.id)) {
                  shared.addTrack(t);
                  studentTracksRef.current[studentSocketId] =
                    studentTracksRef.current[studentSocketId] || [];
                  studentTracksRef.current[studentSocketId].push(t);

                  // forward this incoming track to all other student PCs
                  forwardTrackToAllExcept(studentSocketId, t);
                }
              }

              // attach the combined shared stream to the single audio element (teacher hears)
              if (audioRef.current) {
                audioRef.current.srcObject = shared;
                audioRef.current.play().catch((err) => {
                  console.warn("Autoplay blocked for shared audio:", err);
                });
              }
            };

            pc.onicecandidate = (event) => {
              if (event.candidate && socketRef.current) {
                socketRef.current.emit("sendIceCandidateToSignalingServer", {
                  offererSocketId: studentSocketId,
                  candidate: event.candidate,
                  fromSocketId: socketRef.current.id,
                });
              }
            };

            pc.onconnectionstatechange = () => {
              console.log(
                `pc[${studentSocketId}] connectionState:`,
                pc.connectionState,
                "signalingState:",
                pc.signalingState
              );
              if (
                pc.connectionState === "disconnected" ||
                pc.connectionState === "failed" ||
                pc.connectionState === "closed"
              ) {
                // cleanup that student's tracks and forwarded senders
                try {
                  removeStudentTracks(studentSocketId);
                } catch (e) {}
              }
            };

            // ensure tracks are removed when pc.close is called
            const oldClose = pc.close.bind(pc);
            pc.close = () => {
              try {
                removeStudentTracks(studentSocketId);
              } catch (e) {}
              try {
                oldClose();
              } catch (e) {}
            };

            return pc;
          };

          // Setup all socket handlers for teacher
          socket.on("availableOffers", async (offers = []) => {
            for (const offer of offers) {
              try {
                const pc = createPcForStudent(offer.offererSocketId);

                if (!pc.remoteDescription) {
                  await pc.setRemoteDescription(offer.offer);
                }

                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);

                  // debug log of senders
                  try {
                    console.log("Teacher: pc.getSenders()", offer.offererSocketId, pc.getSenders().map(s => ({ id: s.track?.id, kind: s.track?.kind })));
                  } catch (e) {}

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: offer.offererSocketId, answer },
                    (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        offererIceCandidates.forEach(async (c) => {
                          try {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (availableOffers) err", e);
                          }
                        });
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${offer.offererSocketId}, state=${pc.signalingState}`
                  );
                }
              } catch (err) {
                console.warn("teacher answering failed", offer.offererSocketId, err);
              }
            }
          });

          socket.on("newOfferAwaiting", async (recentOffers) => {
            for (const offerObj of recentOffers) {
              if (!offerObj || offerObj.answer) continue;
              const student = offerObj.offererSocketId;
              if (!student) continue;

              const pc = createPcForStudent(student);
              try {
                if (!pc.remoteDescription) {
                  await pc.setRemoteDescription(offerObj.offer);
                }

                if (pc.signalingState === "have-remote-offer") {
                  const answer = await pc.createAnswer();
                  await pc.setLocalDescription(answer);

                  // debug senders
                  try {
                    console.log("Teacher: pc.getSenders()", student, pc.getSenders().map(s => ({ id: s.track?.id, kind: s.track?.kind })));
                  } catch (e) {}

                  socket.emit(
                    "newAnswer",
                    { offererSocketId: student, answer },
                    async (offererIceCandidates) => {
                      if (Array.isArray(offererIceCandidates)) {
                        for (const c of offererIceCandidates) {
                          try {
                            await pc.addIceCandidate(new RTCIceCandidate(c));
                          } catch (e) {
                            console.warn("teacher addIceCandidate (newOfferAwaiting) err", e);
                          }
                        }
                      }
                    }
                  );
                } else {
                  console.log(
                    `Teacher: skipping answer for ${student}, state=${pc.signalingState}`
                  );
                }
              } catch (err) {
                console.warn(
                  "teacher answering failed for (newOfferAwaiting)",
                  student,
                  err
                );
              }
            }
          });

          socket.on("receivedIceCandidateFromServer", async (payload) => {
            if (!payload) return;
            const from = payload.fromSocketId;
            const candidate = payload.candidate;
            if (!from || !candidate) return;

            const pc = pcsRef.current[from];
            if (pc) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.warn("teacher addIceCandidate (receivedIceCandidateFromServer) err", e);
              }
            }
          });

          socket.on("roomClosed", ({ reason }) => {
            console.log("roomClosed", reason);
            setConnectionStatus("Room closed");
            
            // remove all student tracks
            Object.keys(studentTracksRef.current).forEach((id) => {
              (studentTracksRef.current[id] || []).forEach((t) => {
                try {
                  sharedStreamRef.current.removeTrack(t);
                } catch (e) {}
                try { removeForwardedTrack(t); } catch (e) {}
              });
            });
            studentTracksRef.current = {};
            
            // close all pcs
            Object.keys(pcsRef.current).forEach((k) => {
              try {
                pcsRef.current[k].getSenders().forEach((s) => s.track?.stop());
                pcsRef.current[k].close();
              } catch {}
            });
            pcsRef.current = {};
            forwardedSendersRef.current = {};
            
            // clear shared stream
            try {
              sharedStreamRef.current.getTracks().forEach((t) => t.stop?.());
            } catch {}
            sharedStreamRef.current = new MediaStream();
            if (audioRef.current) audioRef.current.srcObject = null;
          });
        }
      } catch (err) {
        console.error("Setup failed:", err);
        setConnectionStatus(`Error: ${err.message}`);
      }
    };

    setup();

    return () => {
      mounted = false;
      if (socketRef.current) {
        socketRef.current.off("availableOffers");
        socketRef.current.off("newOfferAwaiting");
        socketRef.current.off("answerResponse");
        socketRef.current.off("receivedIceCandidateFromServer");
        socketRef.current.off("roomClosed");
      }

      if (pcRef.current) {
        try {
          pcRef.current.getSenders().forEach((sender) => sender.track?.stop());
          pcRef.current.close();
        } catch {}
      }

      Object.values(pcsRef.current || {}).forEach((pc) => {
        try {
          pc.getSenders().forEach((s) => s.track?.stop());
          pc.close();
        } catch {}
      });

      // remove and stop all student tracks from shared stream and forwarded copies
      Object.keys(studentTracksRef.current).forEach((id) => {
        (studentTracksRef.current[id] || []).forEach((t) => {
          try {
            sharedStreamRef.current.removeTrack(t);
          } catch (e) {}
          try { removeForwardedTrack(t); } catch (e) {}
          try { t.stop?.(); } catch (e) {}
        });
      });
      studentTracksRef.current = {};
      forwardedSendersRef.current = {};

      // clear and stop shared stream tracks
      try {
        sharedStreamRef.current.getTracks().forEach((t) => {
          try {
            t.stop?.();
          } catch {}
        });
      } catch {}
      sharedStreamRef.current = new MediaStream();

      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, roomId, role]);

  const toggleAudio = () => {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks()[0]?.enabled ?? false;
    localStream.getAudioTracks().forEach((track) => (track.enabled = !enabled));
    setAudioEnabled(!enabled);
  };

  return (
    <div>
      <h2>
        Audio Call — {displayName || "(no name)"} ({role})
      </h2>

      {/* Connection status */}
      <div style={{ 
        padding: '10px', 
        backgroundColor: connectionStatus.includes('Connected') ? '#d4edda' : 
                        connectionStatus.includes('Error') || connectionStatus.includes('Failed') ? '#f8d7da' : '#fff3cd',
        border: '1px solid #ccc',
        borderRadius: '4px',
        marginBottom: '10px' 
      }}>
        Status: {connectionStatus}
      </div>

      {/* Single audio element used by both roles:
          - Student: plays teacher stream (teacher sends teacher mic + forwarded student tracks)
          - Teacher: plays combined sharedStream of incoming student tracks + teacher mic */}
      <audio ref={audioRef} autoPlay playsInline controls />

      {/* Action buttons */}
      <ActionButtons localStream={localStream} toggleAudio={toggleAudio} />

      <div style={{ marginTop: 10 }}>
        <div>Room: {roomId}</div>
        <div>Microphone available: {haveMedia ? "Yes" : "No"}</div>
        <div>Audio enabled: {audioEnabled ? "Yes" : "No"}</div>
      </div>
    </div>
  );
};

export default AudioCall;