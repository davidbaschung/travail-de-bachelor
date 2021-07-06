console.log("Sender script loaded");

var senderConnection;	/* Sender RTCPeerConnection 				*/
var senderCertificate;	/* Sender authentication certificate		*/
var currentReceiverID;	/* Receiver Socket ID  						*/
var senderDataChannel;	/* Sender P2P DataChannel 					*/
var readyForSending		/* Kill-switch, in case of connection loss	*/

/**
 *	Prepares the sending, called from the page script.
 *	Creates a certificate and displays the receiver code.
 *	Send the files list to the server. A confirmation is given back.
 */
function launchClientSender() {
	console.log("Client Sender will send "+filesToSend.length+" files.");
    var filesMsg = [filesToSend.length];
    for (var i=0; i<filesToSend.length; i++) {
        var f = filesToSend[i];
        filesMsg[i] = {
            "name" : f.name,
            "size" : f.size
        }
    }
	RTCPeerConnection.generateCertificate(encryptionAlgorithm).then(function(certificates) {
		senderCertificate = certificates;
		var receiverCode = hashToPassphrase(certificates.getFingerprints()[0].value);
		setCodeLabel(receiverCode, "receiverCodeContainer");
		socket.emit('requestNewRoom', filesMsg, receiverCode);
	});
	readyForSending = true;
}
socket.on('newRoomCreated', function() {
	console.log("Socket : new room created on the server");
});

/**
 * Orders the server to abort the upload. A confirmation is received.
 * @param {string} receiverCode - Room code for the server
 */
function abortUpload(receiverCode) {
	console.log("Upload aborting");
	socket.emit("abortUpload", receiverCode, currentReceiverID);
}
socket.on('uploadAborted', function() {
	console.log("Upload aborted");
});

/* The servers gives notice of a receiver arrival. Its socket ID is stored. */
socket.on("receiverJoined", function (receiverID) {
	currentReceiverID = receiverID;
	console.log("Socket : A receiver entered the code and joined the room");
});

/** 
 *  The server gives notice of a download initialization request.
 * 	Starts a new P2P connection and creates a DataChannel.
 */
socket.on("initDownload", function() {
	console.log("Socket : initializing download");
	senderConnection = new RTCPeerConnection({
		iceServers: iceServers,
		certificates: [senderCertificate]
	});
	senderConnection.onicecandidate = onIceCandidateRTC_A;
	senderConnection.oniceconnectionstatechange = iceConnectionStateChange_A;  //= (event) => console.log("RTC : ICE state : ",event.target.connectionState);
	var senderDataChannelOptions = {
		ordered:true,
		binaryType:"arraybuffer",
	};
	senderDataChannel = senderConnection.createDataChannel(socket.id, senderDataChannelOptions);
	senderDataChannel.binaryType = "arraybuffer";
	senderDataChannel.onopen = openSendingDC;
	senderDataChannel.onclose = closeSendingDC;
	senderDataChannel.onmessage = (message) => {console.log("DataChannel : message : ", message.data)};
	senderDataChannel.onerror = (error) => {console.log("DataChannel : ERROR : ", error); };
	startSignaling();
});

/* Starts the signaling process, sends an SDP offer. Called on receiver request. */
function startSignaling() {
	console.log("RTC : start signaling process - - - - - - - - - - - - -")
	senderConnection.createOffer(
		function (offerSDP) {
			senderConnection.setLocalDescription(offerSDP);
			socket.emit("offerSDP", offerSDP, currentReceiverID);
		},
		function (error) {
			console.log(error);
		},
		options = {
			"iceRestart" : false,
		}
	)
}

/**
 * Delivers the SDP answer to the previously sent SDP offer.
 * Controls the certificate : derives the code from the fingerprint provided
 * in the SDP answer and compares it to the inputed sender code.
 * Passes the SDP answer to the peer connection previously created.
 */
socket.on("answerSDP", function (answerSDP) {
	console.log("Socket : Received SDP answer");
	var inputedSenderCode = getInput(false);
	// inputedSenderCode = "fakeWrongCodeForCerticateTesting";
	if (hashToPassphrase(getSDPFingerprint(answerSDP)) != inputedSenderCode) {
		setFeedback(false, "The receiver's authentication certificate is not valid or the code is wrong.",colors.RED);
		socket.emit("receiverAuthenticationFailed", currentReceiverID);
		return;
	}
	console.log("The fingerprint authentication succeeded");
	senderConnection.setRemoteDescription(answerSDP);
});

/**
 * Called by the local RTCPeerConnection on candidate creation.
 * This sends the created ICE candidate to the receiver.
 * It also manages the connection state changes, the sender is the connection master.
 * @param {RTCPeerConnectionIceEvent} event - Networking ICE event, contains an RTCIceCandidate
 */
async function onIceCandidateRTC_A(event) {
	if (senderConnection == null) return;
	while (senderConnection.remoteDescription==undefined)
		await asyncSleep(50);
	console.log("RTC : IceCandidateA created, it will be sent");
	if (event.candidate) {
		socket.emit("IceCandidateA", event.candidate, currentReceiverID);
	} else {
		console.log ("RTC : End-of-candidates");
	}
}

/** Delivers an ICE candidate from the receiver to the local connection. */
socket.on("IceCandidateB", function (IceCandidateB) {
	console.log("Socket : Received ICE Candidate B");
	if (senderConnection == null) return;
	senderConnection.addIceCandidate(IceCandidateB)
	.then(
		function() {
			console.log("RTC : addIceCandidateB Success");
		},
		function(error) {
			console.log("RTC : addIceCandidateB FAILED : ", error);
		}
	);
});

/**
 * Delivers the receiver's status.
 * Displays the percentage of transfer accomplishment in the feedback panel.
 */
socket.on("transferStatus", function (newStatus) {
	updateTransferStatus(false, newStatus+"% uploaded", true);
	if (newStatus.includes("100"))
		setResetButtonLabel("reset");
});

/* Start files sending. Called by the DataChannel on opening. */
function openSendingDC() {
	console.log("DataChannel : open Sending");
	setResetButtonLabel("cancel");
	setFeedback(false, "","");
	readyForSending ? sendFilesAsync() : restoreDataChannel();
	sendFileAsync();
}

/* Closes files sending. Called by the DataChannel on closing. */
function closeSendingDC() {
	console.log("DataChannel : close sending, dataChannel & connection");
	if (senderConnection != undefined) {
		senderDataChannel.close();
		senderConnection.close();
	}
	senderConnection = null;
	currentReceiverID = null;
	senderDataChannel = null;
}

/**
 * Re-establishes the socket connection, updates the room's host socket on the server.
 * @param {Event} event - state change event, with connectivity informations.
 */
function iceConnectionStateChange_A(event) {
	const MAXCOUNT = 600;
	function checkConnectivity(count) {
		if (senderConnection==null || senderConnection==undefined)
			return;
		console.log("RTC : ICE state : ",event.target.connectionState);
		var state = senderConnection.iceConnectionState;
		if ( ! ( state == "connected" ) ) {
			if (count < MAXCOUNT) {
				asyncSleep(1000).then(() => {
					if (count==9) {
						console.log("RTC+Socket : connection lost, reconnecting");
						readyForSending = false;
						socket = io.connect(url);
						console.log("Socket : new socket created");
						socket.emit("restoreConnection", getInput(false), true);
						// senderDataChannel.bufferedAmount
						return;
					}
					checkConnectivity(++count);
				});
			} else {
				closeReceivingDC();
				setFeedback(false,"The connection failed, download cancelled.",colors.RED);
			}
		}
	}
	checkConnectivity(0);
}

// socket.on("restartSignaling", function (receiverID) {
// 	console.log("Socket : restarting signaling");
// 	currentReceiverID = receiverID;
// 	senderConnection.restartIce();
// 	startSignaling(true);
// });