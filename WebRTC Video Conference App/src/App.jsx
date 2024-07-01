import React, { useState, useRef } from "react";

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// TODO: https://firebase.google.com/docs/web/setup#available-libraries

// * Initialize Firebase from firebaseConfig
import { firebaseConfig } from "./firebaseConfig";

import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    addDoc,
    updateDoc,
    collection,
    onSnapshot,
} from "firebase/firestore";

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

const db = getFirestore(app);

const App = () => {
    //? RTCPeerConnection generates ICE Candidates
    const servers = {
        iceServers: [
            {
                urls: [
                    "stun:stun1.l.google.com:19302",
                    "stun:stun2.l.google.com:19302",
                ],
            },
        ],
        iceCandidatePoolSize: 10,
    };

    //! Initializing three pieces of global state
    let pc = new RTCPeerConnection(servers);
    //! video streams from the webcams
    const [localStream, setLocalStream] = useState(null); //? your webcam
    const [remoteStream] = useState(new MediaStream()); //? your friend's webcam

    //? this is only for StartWebcam, Call Offer and Answer Button.
    const [isDisabled, setIsDisabled] = useState(false);
    //? this is only for the hangupbutton
    const [isHangupButtonDisabled, setIsHangupButtonDisabled] = useState(true);
    //? using useRef

    const webcamButtonRef = useRef(null);
    const webcamVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const callButtonRef = useRef(null);
    const answerButtonRef = useRef(null);
    const hangupButtonRef = useRef(null);

    const callInput = document.getElementById("callInput");
    //! 1. Setup media sources
    const handleStartWebcam = async () => {
        let localstream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        });
        setLocalStream(localstream);

        //! Push tracks from local stream to peer connection
        localstream.getTracks().forEach((track) => {
            pc.addTrack(track, localstream);
        });

        //! Pull tracks from remote stream, add to video stream
        pc.ontrack = (event) => {
            event.streams[0].getTracks().forEach((track) => {
                remoteStream.addTrack(track);
            });
        };

        if (webcamVideoRef.current) {
            webcamVideoRef.current.srcObject = localstream;
        }
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
        }

        setIsDisabled(!isDisabled);
    };

    //! 2. Create an offer
    //? Person who starts the call, makes the "offer"
    const handleCallButton = async () => {
        //! Reference Firestore collections for signaling
        const callDocRef = doc(collection(db, "calls"));

        callInput.value = callDocRef.id;

        //? We have a call document which is used to manage the offer and answer from both users
        //? The two sub-collections of callDoc are offerCandidates and AnswerCandidates.
        const offerCandidates = collection(callDocRef, "offerCandidates");
        const answerCandidates = collection(callDocRef, "answerCandidates");
        //? when we reference a document without an id,
        //? firebase will automatically generate a random id for us
        //? lets use that here to populate the input in the UI used to answer the ca(callDocRef.id);
        //? Get candidates for caller, save to db
        //? this is the listener listening to the ICE Candidates
        pc.onicecandidate = (event) => {
            event.candidate && offerCandidates.add(event.candidate.toJSON());
        };
        //! when the event setLocalDescription is fired, we make sure that a candidate exists
        //! then write the data as JSON to the "offer" collection

        //! Create offer
        const offerDescription = await pc.createOffer();
        //? pc.createOFfer() will return us with the offer description
        //? now we will set it as the local description on the pc
        await pc.setLocalDescription(offerDescription);
        //? the setLocalDescription when called automatically starts generating ICE Candidates.
        //? an ICE Candidate contains a potential IP and a Port Pair that can used to establish the actual P2P connection
        //! We need to be listening to the ICE Candidates,
        //! so we need to make sure that we have a listener established before calling the function.

        //? the offer consists of SDP value (SDP = Session Description Protocol)
        //? i.e. the value we need to save to the database

        //? first lets convert it to a plain js object
        const offer = {
            sdp: offerDescription.sdp,
            type: offerDescription.type,
        };
        //? now lets write it to the database
        await setDoc(callDocRef, { offer });

        // * Till here, as we click the call button, we are getting the required data and writing it to the DB

        //! now we need to also be listening for the "answer" from the remote user

        //? we can do this by listening to changes on the callDoc using onSnapShot method
        //? onSnapShot method fires a callback anytime the document in the database changes
        onSnapshot(callDocRef, (snapshot) => {
            const data = snapshot.data();
            if (!pc.currentRemoteDescription && data?.answer) {
                //? currentRemoteDescription is null and data has an answer then
                //? we will create an answerDescription on our PC here locally
                const answerDescription = new RTCSessionDescription(
                    data.answer
                );
                pc.setRemoteDescription(answerDescription);
            }
            //? in other words, we are listening to our DB for an answer,
            //? and when it's received, we update it on our PC.
        });

        // * now onSnapShot takes care of the Initial Connection.
        // * But we also need to listen to ICE Candidates from Answering User.

        //! to do that, we need to listen to the Answer candidates collection
        // When answered, add candidate to peer connection
        onSnapshot(answerCandidates, (snapshot) => {
            //? firestore provides dotChanges() which listens to only
            //? the documents that have been added to the collection.
            snapshot.docChanges().forEach((change) => {
                if (change.type === "added") {
                    //? creating a new ICE Candidate with document data
                    const candidate = new RTCIceCandidate(change.doc.data());
                    //? and now we add that data to the PC
                    pc.addIceCandidate(candidate);
                }
            });
        });

        setIsHangupButtonDisabled(!isHangupButtonDisabled);
        // * at this point, we are listening to the updates form the answer side
        // * but we still need to give the answering user a way to answer the call
        // * that will be done by answerButton's onClick.
    };

    //! 3. Answer the call with the unique ID
    //? Answering the call is very similar to initiating the call
    //? the Difference is that we need to listen to document firestore
    //? with the same doc id that was created by the caller

    const handleAnswerButton = async () => {
        //? we will make a refrence to that document and also answerCandidates collection
        const callId = callInput.value;
        const callDocRef = doc(db, "calls", callId);
        const answerCandidates = collection(callDocRef, "answerCandidates");
        const offerCandidates = collection(callDocRef, "offerCandidates");

        //? listen to the ICE Candidates Event on the PC
        //? to update the answer Candidate collection whenever a new Candidate is generated
        pc.onicecandidate = (event) => {
            event.candidate &&
                addDoc(answerCandidates, event.candidate.toJSON());
        };

        //? now fetch the callDoc form the DB andgrab its data

        const callDocData = (await getDoc(callDocRef)).data();
        //? the callDoc contains the "offer data"
        //? we can use to set a RemoteDescription on the PC
        const offerDescription = callDocData.offer;
        await pc.setRemoteDescription(
            new RTCSessionDescription(offerDescription)
        );

        //? now we generate an answer description locally
        //? then set the local description as the answer
        const answerDescription = await pc.createAnswer();
        await pc.setLocalDescription(answerDescription);

        //? now same as before
        //? we will set it up as a plain object and then
        //? update it on the callDoc
        const answer = {
            type: answerDescription.type,
            sdp: answerDescription.sdp,
        };

        //? updating the callDoc so that the other user can listen to the answer
        await updateDoc(callDocRef, { answer });

        //! I HAVE NO IDEA WHY WE NEED TO DO THIS
        onSnapshot(offerCandidates, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === "added") {
                    const candidate = new RTCIceCandidate(change.doc.data());
                    pc.addIceCandidate(candidate);
                }
            });
        });
    };
    return (
        <React.Fragment>
            <h2>1. Start your Webcam</h2>
            <div className="videos">
                <span>
                    <h3>Local Stream</h3>
                    <video
                        id="webcamVideo"
                        ref={webcamVideoRef}
                        autoPlay
                        playsInline
                    ></video>
                </span>
                <span>
                    <h3>Remote Stream</h3>
                    <video
                        id="remoteVideo"
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                    ></video>
                </span>
            </div>

            <button
                id="webcamButton"
                onClick={handleStartWebcam}
                ref={webcamButtonRef}
                disabled={isDisabled}
            >
                Start webcam
            </button>
            <h2>2. Create a new Call</h2>
            <button
                id="callButton"
                disabled={!isDisabled}
                onClick={handleCallButton}
                ref={callButtonRef}
            >
                Create Call (offer)
            </button>

            <h2>3. Join a Call</h2>
            <p>Answer the call from a different browser window or device</p>

            <input id="callInput" />
            <button
                id="answerButton"
                disabled={!isDisabled}
                onClick={handleAnswerButton}
                ref={answerButtonRef}
            >
                Answer
            </button>

            <h2>4. Hangup</h2>

            <button
                id="hangupButton"
                disabled={isHangupButtonDisabled}
                ref={hangupButtonRef}
            >
                Hangup
            </button>
        </React.Fragment>
    );
};

export default App;
