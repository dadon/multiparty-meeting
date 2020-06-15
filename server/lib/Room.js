const EventEmitter = require('events').EventEmitter;
const Logger = require('./Logger');
const Lobby = require('./Lobby');
const config = require('../config/config');

const logger = new Logger('Room');

class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorker, roomId })
	{
		logger.info('create() [roomId:"%s"]', roomId);

		// Router media codecs.
		const mediaCodecs = config.mediasoup.router.mediaCodecs;

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		return new Room({ roomId, mediasoupRouter, audioLevelObserver });
	}

	constructor({ roomId, mediasoupRouter, audioLevelObserver })
	{
		logger.info('constructor() [roomId:"%s"]', roomId);

		super();
		this.setMaxListeners(Infinity);

		// Room ID.
		this._roomId = roomId;

		// Closed flag.
		this._closed = false;

		// Locked flag.
		this._locked = false;

		// if true: accessCode is a possibility to open the room
		this._joinByAccesCode = true;

		// access code to the room,
		// applicable if ( _locked == true and _joinByAccessCode == true )
		this._accessCode = '';

		this._lobby = new Lobby();

		this._chatHistory = [];

		this._fileHistory = [];

		this._lastN = [];

		this._peers = {};

		// Map of broadcasters indexed by id. Each Object has:
		// - {String} id
		// - {Object} data
		//   - {String} displayName
		//   - {Object} device
		//   - {RTCRtpCapabilities} rtpCapabilities
		//   - {Map<String, mediasoup.Transport>} transports
		//   - {Map<String, mediasoup.Producer>} producers
		//   - {Map<String, mediasoup.Consumers>} consumers
		//   - {Map<String, mediasoup.DataProducer>} dataProducers
		//   - {Map<String, mediasoup.DataConsumers>} dataConsumers
		// @type {Map<String, Object>}
		this._broadcasters = new Map();

		// mediasoup Router instance.
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		this._audioLevelObserver = audioLevelObserver;

		// Current active speaker.
		this._currentActiveSpeaker = null;

		this._handleLobby();
		this._handleAudioLevelObserver();
	}

	getRouterRtpCapabilities() {
		return this._mediasoupRouter.rtpCapabilities;
	}

	/**
	 * Create a Broadcaster. This is for HTTP API requests (see server.js).
	 *
	 * @async
	 *
	 * @type {String} id - Broadcaster id.
	 * @type {String} displayName - Descriptive name.
	 * @type {Object} [device] - Additional info with name, version and flags fields.
	 * @type {RTCRtpCapabilities} [rtpCapabilities] - Device RTP capabilities.
	 */
	async createBroadcaster({ id, displayName, device = {}, rtpCapabilities })
	{
		if (typeof id !== 'string' || !id)
			throw new TypeError('missing body.id');
		else if (typeof displayName !== 'string' || !displayName)
			throw new TypeError('missing body.displayName');
		else if (typeof device.name !== 'string' || !device.name)
			throw new TypeError('missing body.device.name');
		else if (rtpCapabilities && typeof rtpCapabilities !== 'object')
			throw new TypeError('wrong body.rtpCapabilities');

		if (this._broadcasters.has(id))
			throw new Error(`broadcaster with id "${id}" already exists`);

		const broadcaster =
			{
				id,
				data :
					{
						displayName,
						device :
							{
								flag    : 'broadcaster',
								name    : device.name || 'Unknown device',
								version : device.version
							},
						rtpCapabilities,
						transports    : new Map(),
						producers     : new Map(),
						consumers     : new Map(),
						dataProducers : new Map(),
						dataConsumers : new Map()
					}
			};

		// Store the Broadcaster into the map.
		this._broadcasters.set(broadcaster.id, broadcaster);

		// Notify the new Broadcaster to all Peers.
		for (const otherPeer of this._getJoinedPeers())
		{
			this._notification(
				otherPeer.socket,
				'newPeer',
				{
					id          : broadcaster.id,
					displayName : broadcaster.data.displayName,
					device      : broadcaster.data.device
				}
			);
		}

		// Reply with the list of Peers and their Producers.
		const peerInfos = [];
		const joinedPeers = this._getJoinedPeers();

		// Just fill the list of Peers if the Broadcaster provided its rtpCapabilities.
		if (rtpCapabilities)
		{
			for (const joinedPeer of joinedPeers)
			{
				const peerInfo =
					{
						id          : joinedPeer.id,
						displayName : joinedPeer.data.displayName,
						device      : joinedPeer.data.device,
						producers   : []
					};

				for (const producer of joinedPeer.data.producers.values())
				{
					// Ignore Producers that the Broadcaster cannot consume.
					if (
						!this._mediasoupRouter.canConsume(
							{
								producerId : producer.id,
								rtpCapabilities
							})
					)
					{
						continue;
					}

					peerInfo.producers.push(
						{
							id   : producer.id,
							kind : producer.kind
						});
				}

				peerInfos.push(peerInfo);
			}
		}

		return { peers: peerInfos };
	}

	/**
	 * Delete a Broadcaster.
	 *
	 * @type {String} broadcasterId
	 */
	deleteBroadcaster({ broadcasterId })
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		for (const transport of broadcaster.data.transports.values())
		{
			transport.close();
		}

		this._broadcasters.delete(broadcasterId);

		for (const peer of this._getJoinedPeers())
		{
			this._notification(
				peer.socket,
				'peerClosed',
				{
					peerId: broadcasterId
				}
			);
		}
	}

	/**
	 * Create a mediasoup Transport associated to a Broadcaster. It can be a
	 * PlainTransport or a WebRtcTransport.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} type - Can be 'plain' (PlainTransport) or 'webrtc'
	 *   (WebRtcTransport).
	 * @type {Boolean} [rtcpMux=false] - Just for PlainTransport, use RTCP mux.
	 * @type {Boolean} [comedia=true] - Just for PlainTransport, enable remote IP:port
	 *   autodetection.
	 * @type {Object} [sctpCapabilities] - SCTP capabilities
	 */
	async createBroadcasterTransport(
		{
			broadcasterId,
			type,
			rtcpMux = false,
			comedia = true,
			sctpCapabilities
		})
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		switch (type)
		{
			case 'plain':
			{
				const plainTransportOptions =
					{
						...config.mediasoup.plainTransportOptions,
						rtcpMux : rtcpMux,
						comedia : comedia
					};

				const transport = await this._mediasoupRouter.createPlainTransport(
					plainTransportOptions);

				// Store it.
				broadcaster.data.transports.set(transport.id, transport);

				return {
					id       : transport.id,
					ip       : transport.tuple.localIp,
					port     : transport.tuple.localPort,
					rtcpPort : transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined
				};
			}

			default:
			{
				throw new TypeError('invalid type');
			}
		}
	}

	/**
	 * Connect a Broadcaster mediasoup WebRtcTransport.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {RTCDtlsParameters} dtlsParameters - Remote DTLS parameters.
	 */
	async connectBroadcasterTransport(
		{
			broadcasterId,
			transportId,
			dtlsParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		if (transport.constructor.name !== 'WebRtcTransport')
		{
			throw new Error(
				`transport with id "${transportId}" is not a WebRtcTransport`);
		}

		await transport.connect({ dtlsParameters });
	}

	/**
	 * Create a mediasoup Producer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} kind - 'audio' or 'video' kind for the Producer.
	 * @type {RTCRtpParameters} rtpParameters - RTP parameters for the Producer.
	 */
	async createBroadcasterProducer(
		{
			broadcasterId,
			transportId,
			kind,
			rtpParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const producer =
			await transport.produce({ kind, rtpParameters });

		// Store it.
		broadcaster.data.producers.set(producer.id, producer);

		// Set Producer events.
		// producer.on('score', (score) =>
		// {
		// 	logger.debug(
		// 		'broadcaster producer "score" event [producerId:%s, score:%o]',
		// 		producer.id, score);
		// });

		producer.on('videoorientationchange', (videoOrientation) =>
		{
			logger.debug(
				'broadcaster producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
				producer.id, videoOrientation);
		});

		// Optimization: Create a server-side Consumer for each Peer.
		for (const peer of this._getJoinedPeers())
		{
			this._createConsumer(
				{
					consumerPeer : peer,
					producerPeer : broadcaster,
					producer
				}).catch(() => {});
		}

		// Add into the audioLevelObserver.
		if (producer.kind === 'audio')
		{
			this._audioLevelObserver.addProducer({ producerId: producer.id })
				.catch(() => {});
		}

		return { id: producer.id };
	}

	isLocked()
	{
		return this._locked;
	}

	close()
	{
		logger.debug('close()');

		this._closed = true;

		this._lobby.close();

		// Close the peers.
		for (const peer in this._peers)
		{
			if (Object.prototype.hasOwnProperty.call(this._peers, peer))
			{
				if (!peer.closed)
					peer.close();
			}
		}

		this._peers = null;

		// Close the mediasoup Router.
		this._mediasoupRouter.close();

		// Emit 'close' event.
		this.emit('close');
	}

	handlePeer(peer)
	{
		logger.info('handlePeer() [peer:"%s"]', peer.id);

		// This will allow reconnects to join despite lock
		if (this._peers[peer.id])
		{
			logger.warn(
				'handleConnection() | there is already a peer with same peerId [peer:"%s"]',
				peer.id);

			peer.close();

			return;
		}
		else if (this._locked)
		{
			this._parkPeer(peer);
		}
		else
		{
			peer.authenticated ?
				this._peerJoining(peer) :
				this._handleGuest(peer);
		}
	}

	_handleGuest(peer)
	{
		if (config.requireSignInToAccess)
		{
			if (config.activateOnHostJoin && !this.checkEmpty())
			{
				this._peerJoining(peer);
			}
			else
			{
				this._parkPeer(peer);
				this._notification(peer.socket, 'signInRequired');
			}
		}
		else
		{
			this._peerJoining(peer);
		}
	}

	_handleLobby()
	{
		this._lobby.on('promotePeer', (promotedPeer) =>
		{
			logger.info('promotePeer() [promotedPeer:"%s"]', promotedPeer.id);

			const { id } = promotedPeer;

			this._peerJoining(promotedPeer);

			for (const peer of this._getJoinedPeers())
			{
				this._notification(peer.socket, 'lobby:promotedPeer', { peerId: id });
			}
		});

		this._lobby.on('peerAuthenticated', (peer) =>
		{
			!this._locked && this._lobby.promotePeer(peer.id);
		});

		this._lobby.on('changeDisplayName', (changedPeer) =>
		{
			const { id, displayName } = changedPeer;

			for (const peer of this._getJoinedPeers())
			{
				this._notification(peer.socket, 'lobby:changeDisplayName', { peerId: id, displayName });
			}
		});

		this._lobby.on('changePicture', (changedPeer) =>
		{
			const { id, picture } = changedPeer;

			for (const peer of this._getJoinedPeers())
			{
				this._notification(peer.socket, 'lobby:changePicture', { peerId: id, picture });
			}
		});

		this._lobby.on('peerClosed', (closedPeer) =>
		{
			logger.info('peerClosed() [closedPeer:"%s"]', closedPeer.id);

			const { id } = closedPeer;

			for (const peer of this._getJoinedPeers())
			{
				this._notification(peer.socket, 'lobby:peerClosed', { peerId: id });
			}
		});

		// If nobody left in lobby we should check if room is empty too and initiating
		// rooms selfdestruction sequence
		this._lobby.on('lobbyEmpty', () =>
		{
			if (this.checkEmpty())
			{
				this.selfDestructCountdown();
			}
		});
	}

	_handleAudioLevelObserver()
	{
		// Set audioLevelObserver events.
		this._audioLevelObserver.on('volumes', (volumes) =>
		{
			const { producer, volume } = volumes[0];

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				this._notification(
					peer.socket,
					'activeSpeaker',
					{
						peerId : producer.appData.peerId,
						volume : volume
					});
			}
		});

		this._audioLevelObserver.on('silence', () =>
		{
			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				this._notification(
					peer.socket,
					'activeSpeaker',
					{ peerId: null }
				);
			}
		});
	}

	logStatus()
	{
		logger.info(
			'logStatus() [room id:"%s", peers:"%s"]',
			this._roomId,
			Object.keys(this._peers).length
		);
	}

	async dump()
	{
		return {
			roomId : this._roomId,
			peers  : Object.keys(this._peers).length
		};
	}

	get id()
	{
		return this._roomId;
	}

	selfDestructCountdown()
	{
		logger.debug('selfDestructCountdown() started');

		setTimeout(() =>
		{
			if (this._closed)
				return;

			if (this.checkEmpty() && this._lobby.checkEmpty())
			{
				logger.info(
					'Room deserted for some time, closing the room [roomId:"%s"]',
					this._roomId);
				this.close();
			}
			else
				logger.debug('selfDestructCountdown() aborted; room is not empty!');
		}, 10000);
	}

	// checks both room and lobby
	checkEmpty()
	{
		return Object.keys(this._peers).length === 0;
	}

	_parkPeer(parkPeer)
	{
		this._lobby.parkPeer(parkPeer);

		for (const peer of this._getJoinedPeers())
		{
			this._notification(peer.socket, 'parkedPeer', { peerId: parkPeer.id });
		}
	}

	_peerJoining(peer)
	{
		peer.socket.join(this._roomId);

		const index = this._lastN.indexOf(peer.id);

		if (index === -1) // We don't have this peer, add to end
		{
			this._lastN.push(peer.id);
		}

		this._peers[peer.id] = peer;

		this._handlePeer(peer);
		this._notification(peer.socket, 'roomReady');
	}

	_handlePeer(peer)
	{
		logger.debug('_handlePeer() [peer:"%s"]', peer.id);

		peer.socket.on('request', (request, cb) =>
		{
			logger.debug(
				'Peer "request" event [method:"%s", peerId:"%s"]',
				request.method, peer.id);

			this._handleSocketRequest(peer, request, cb)
				.catch((error) =>
				{
					logger.error('"request" failed [error:"%o"]', error);

					cb(error);
				});
		});

		peer.on('close', () =>
		{
			if (this._closed)
				return;

			// If the Peer was joined, notify all Peers.
			if (peer.joined)
			{
				this._notification(peer.socket, 'peerClosed', { peerId: peer.id }, true);
			}

			const index = this._lastN.indexOf(peer.id);

			if (index > -1) // We have this peer in the list, remove
			{
				this._lastN.splice(index, 1);
			}

			delete this._peers[peer.id];

			// If this is the last Peer in the room and
			// lobby is empty, close the room after a while.
			if (this.checkEmpty() && this._lobby.checkEmpty())
			{
				this.selfDestructCountdown();
			}
		});

		peer.on('displayNameChanged', ({ oldDisplayName }) =>
		{
			// Ensure the Peer is joined.
			if (!peer.joined)
				return;

			// Spread to others
			this._notification(peer.socket, 'changeDisplayName', {
				peerId         : peer.id,
				displayName    : peer.displayName,
				oldDisplayName : oldDisplayName
			}, true);
		});

		peer.on('pictureChanged', () =>
		{
			// Ensure the Peer is joined.
			if (!peer.joined)
				return;

			// Spread to others
			this._notification(peer.socket, 'changePicture', {
				peerId  : peer.id,
				picture : peer.picture
			}, true);
		});
	}

	async _handleSocketRequest(peer, request, cb)
	{
		switch (request.method)
		{
			case 'getRouterRtpCapabilities':
			{
				cb(null, this._mediasoupRouter.rtpCapabilities);

				break;
			}

			case 'join':
			{

				try
				{
					if (peer.socket.handshake.session.passport.user.displayName)
					{
						this._notification(
							peer.socket,
							'changeDisplayname',
							{
								peerId         : peer.id,
								displayName    : peer.socket.handshake.session.passport.user.displayName,
								oldDisplayName : ''
							},
							true
						);
					}
				}
				catch (error)
				{
					logger.error(error);
				}
				// Ensure the Peer is not already joined.
				if (peer.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					picture,
					rtpCapabilities
				} = request.data;

				// Store client data into the Peer data object.
				peer.displayName = displayName;
				peer.picture = picture;
				peer.rtpCapabilities = rtpCapabilities;

				// Tell the new Peer about already joined Peers.
				// And also create Consumers for existing Producers.

				const joinedPeers =
				[
					...this._getJoinedPeers()
				];

				const peerInfos = joinedPeers
					.filter((joinedPeer) => joinedPeer.id !== peer.id)
					.map((joinedPeer) => (joinedPeer.peerInfo));

				cb(null, { peers: peerInfos, authenticated: peer.authenticated });

				// Mark the new Peer as joined.
				peer.joined = true;

				for (const joinedPeer of joinedPeers)
				{
					// Create Consumers for existing Producers.
					for (const producer of joinedPeer.producers.values())
					{
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : joinedPeer,
								producer
							});
					}
				}


				for (const broadcaster of this._broadcasters.values()) {
					for (const producer of broadcaster.data.producers.values()) {
						console.log("add producer", producer.id, producer)
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : broadcaster,
								producer
							}).catch(() => {});
					}
				}

				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					this._notification(
						otherPeer.socket,
						'newPeer',
						{
							id          : peer.id,
							displayName : displayName,
							picture     : picture
						}
					);
				}

				logger.debug(
					'peer joined [peer: "%s", displayName: "%s", picture: "%s"]',
					peer.id, displayName, picture);

				break;
			}

			case 'createWebRtcTransport':
			{
				// NOTE: Don't require that the Peer is joined here, so the client can
				// initiate mediasoup Transports and be ready when he later joins.

				const { forceTcp, producing, consuming } = request.data;

				const webRtcTransportOptions =
				{
					...config.mediasoup.webRtcTransport,
					appData : { producing, consuming }
				};

				if (forceTcp)
				{
					webRtcTransportOptions.enableUdp = false;
					webRtcTransportOptions.enableTcp = true;
				}

				const transport = await this._mediasoupRouter.createWebRtcTransport(
					webRtcTransportOptions
				);

				transport.on('dtlsstatechange', (dtlsState) =>
				{
					if (dtlsState === 'failed' || dtlsState === 'closed')
						logger.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
				});

				// Store the WebRtcTransport into the Peer data Object.
				peer.addTransport(transport.id, transport);

				cb(
					null,
					{
						id             : transport.id,
						iceParameters  : transport.iceParameters,
						iceCandidates  : transport.iceCandidates,
						dtlsParameters : transport.dtlsParameters
					});

				const { maxIncomingBitrate } = config.mediasoup.webRtcTransport;

				// If set, apply max incoming bitrate limit.
				if (maxIncomingBitrate)
				{
					try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
					catch (error) {}
				}

				break;
			}

			case 'connectWebRtcTransport':
			{
				const { transportId, dtlsParameters } = request.data;
				const transport = peer.getTransport(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				await transport.connect({ dtlsParameters });

				cb();

				break;
			}

			case 'restartIce':
			{
				const { transportId } = request.data;
				const transport = peer.getTransport(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const iceParameters = await transport.restartIce();

				cb(null, iceParameters);

				break;
			}

			case 'produce':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				let { appData } = request.data;
				const transport = peer.getTransport(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				// Add peerId into appData to later get the associated Peer during
				// the 'loudest' event of the audioLevelObserver.
				appData = { ...appData, peerId: peer.id };

				const producer =
					await transport.produce({ kind, rtpParameters, appData });

				// Store the Producer into the Peer data Object.
				peer.addProducer(producer.id, producer);

				// Set Producer events.
				producer.on('score', (score) =>
				{
					this._notification(peer.socket, 'producerScore', { producerId: producer.id, score });
				});

				producer.on('videoorientationchange', (videoOrientation) =>
				{
					logger.debug(
						'producer "videoorientationchange" event [producerId:"%s", videoOrientation:"%o"]',
						producer.id, videoOrientation);
				});

				cb(null, { id: producer.id });

				// Optimization: Create a server-side Consumer for each Peer.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					this._createConsumer(
						{
							consumerPeer : otherPeer,
							producerPeer : peer,
							producer
						});
				}

				// Add into the audioLevelObserver.
				if (kind === 'audio')
				{
					this._audioLevelObserver.addProducer({ producerId: producer.id })
						.catch(() => {});
				}

				break;
			}

			case 'closeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.getProducer(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				producer.close();

				// Remove from its map.
				peer.removeProducer(producer.id);

				cb();

				break;
			}

			case 'pauseProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.getProducer(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.pause();

				cb();

				break;
			}

			case 'resumeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.getProducer(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.resume();

				cb();

				break;
			}

			case 'pauseConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.pause();

				cb();

				break;
			}

			case 'resumeConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.resume();

				cb();

				break;
			}

			case 'setConsumerPreferedLayers':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, spatialLayer, temporalLayer } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

				cb();

				break;
			}

			case 'setConsumerPriority':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, priority } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPriority(priority);

				cb();

				break;
			}

			case 'requestConsumerKeyFrame':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.requestKeyFrame();

				cb();

				break;
			}

			case 'getTransportStats':
			{
				const { transportId } = request.data;
				const transport = peer.getTransport(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const stats = await transport.getStats();

				cb(null, stats);

				break;
			}

			case 'getProducerStats':
			{
				const { producerId } = request.data;
				const producer = peer.getProducer(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				cb(null, stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				cb(null, stats);

				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;
				const oldDisplayName = peer.displayName;

				peer.displayName = displayName;

				// Spread to others
				this._notification(peer.socket, 'changeDisplayName', {
					peerId         : peer.id,
					displayName    : displayName,
					oldDisplayName : oldDisplayName
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'changePicture':
			{
				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { picture } = request.data;

				peer.picture = picture;

				// Spread to others
				this._notification(peer.socket, 'changePicture', {
					peerId  : peer.id,
					picture : picture
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'chatMessage':
			{
				const { chatMessage } = request.data;

				this._chatHistory.push(chatMessage);

				// Spread to others
				this._notification(peer.socket, 'chatMessage', {
					peerId      : peer.id,
					chatMessage : chatMessage
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'serverHistory':
			{
				// Return to sender
				const lobbyPeers = this._lobby.peerList();

				cb(
					null,
					{
						chatHistory  : this._chatHistory,
						fileHistory  : this._fileHistory,
						lastNHistory : this._lastN,
						locked       : this._locked,
						lobbyPeers   : lobbyPeers,
						accessCode   : this._accessCode
					}
				);

				break;
			}

			case 'lockRoom':
			{
				this._locked = true;

				// Spread to others
				this._notification(peer.socket, 'lockRoom', {
					peerId : peer.id
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'unlockRoom':
			{
				this._locked = false;

				// Spread to others
				this._notification(peer.socket, 'unlockRoom', {
					peerId : peer.id
				}, true);

				this._lobby.promoteAllPeers();

				// Return no error
				cb();

				break;
			}

			case 'setAccessCode':
			{
				const { accessCode } = request.data;

				this._accessCode = accessCode;

				// Spread to others
				// if (request.public) {
				this._notification(peer.socket, 'setAccessCode', {
					peerId     : peer.id,
					accessCode : accessCode
				}, true);
				// }

				// Return no error
				cb();

				break;
			}

			case 'setJoinByAccessCode':
			{
				const { joinByAccessCode } = request.data;

				this._joinByAccessCode = joinByAccessCode;

				// Spread to others
				this._notification(peer.socket, 'setJoinByAccessCode', {
					peerId           : peer.id,
					joinByAccessCode : joinByAccessCode
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'promotePeer':
			{
				const { peerId } = request.data;

				this._lobby.promotePeer(peerId);

				// Return no error
				cb();

				break;
			}

			case 'promoteAllPeers':
			{
				this._lobby.promoteAllPeers();

				// Return no error
				cb();

				break;
			}

			case 'sendFile':
			{
				const { magnetUri } = request.data;

				this._fileHistory.push({ peerId: peer.id, magnetUri: magnetUri });

				// Spread to others
				this._notification(peer.socket, 'sendFile', {
					peerId    : peer.id,
					magnetUri : magnetUri
				}, true);

				// Return no error
				cb();

				break;
			}

			case 'raiseHand':
			{
				const { raisedHand } = request.data;

				peer.raisedHand = raisedHand;

				// Spread to others
				this._notification(peer.socket, 'raiseHand', {
					peerId     : peer.id,
					raisedHand : raisedHand
				}, true);

				// Return no error
				cb();

				break;
			}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				cb(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	/**
	 * Creates a mediasoup Consumer for the given mediasoup Producer.
	 *
	 * @async
	 */
	async _createConsumer({ consumerPeer, producerPeer, producer })
	{
		logger.debug(
			'_createConsumer() [consumerPeer:"%s", producerPeer:"%s", producer:"%s"]',
			consumerPeer.id,
			producerPeer.id,
			producer.id
		);

		// Optimization:
		// - Create the server-side Consumer. If video, do it paused.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		if (
			!consumerPeer.rtpCapabilities ||
			!this._mediasoupRouter.canConsume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.rtpCapabilities
				})
		)
		{
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = consumerPeer.getConsumerTransport();

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createConsumer() | Transport for consuming not found');

			return;
		}

		// Create the Consumer in paused mode.
		let consumer;

		try
		{
			consumer = await transport.consume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.rtpCapabilities,
					paused          : producer.kind === 'video'
				});

			if (producer.kind === 'audio')
				await consumer.setPriority(255);
		}
		catch (error)
		{
			logger.warn('_createConsumer() | [error:"%o"]', error);

			return;
		}

		// Store the Consumer into the consumerPeer data Object.
		consumerPeer.addConsumer(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			consumerPeer.removeConsumer(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			consumerPeer.removeConsumer(consumer.id);

			this._notification(consumerPeer.socket, 'consumerClosed', { consumerId: consumer.id });
		});

		consumer.on('producerpause', () =>
		{
			this._notification(consumerPeer.socket, 'consumerPaused', { consumerId: consumer.id });
		});

		consumer.on('producerresume', () =>
		{
			this._notification(consumerPeer.socket, 'consumerResumed', { consumerId: consumer.id });
		});

		consumer.on('score', (score) =>
		{
			this._notification(consumerPeer.socket, 'consumerScore', { consumerId: consumer.id, score });
		});

		consumer.on('layerschange', (layers) =>
		{
			this._notification(
				consumerPeer.socket,
				'consumerLayersChanged',
				{
					consumerId    : consumer.id,
					spatialLayer  : layers ? layers.spatialLayer : null,
					temporalLayer : layers ? layers.temporalLayer : null
				}
			);
		});

		// Send a request to the remote Peer with Consumer parameters.
		try
		{
			await this._request(
				consumerPeer.socket,
				'newConsumer',
				{
					peerId         : producerPeer.id,
					kind           : consumer.kind,
					producerId     : producer.id,
					id             : consumer.id,
					rtpParameters  : consumer.rtpParameters,
					type           : consumer.type,
					appData        : producer.appData,
					producerPaused : consumer.producerPaused
				}
			);

			// Now that we got the positive response from the remote Peer and, if
			// video, resume the Consumer to ask for an efficient key frame.
			await consumer.resume();

			this._notification(
				consumerPeer.socket,
				'consumerScore',
				{
					consumerId : consumer.id,
					score      : consumer.score
				}
			);
		}
		catch (error)
		{
			logger.warn('_createConsumer() | [error:"%o"]', error);
		}
	}

	/**
	 * Helper to get the list of joined peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		return Object.values(this._peers)
			.filter((peer) => peer.joined && peer !== excludePeer);
	}

	_timeoutCallback(callback)
	{
		let called = false;

		const interval = setTimeout(
			() =>
			{
				if (called)
					return;
				called = true;
				callback(new Error('Request timeout.'));
			},
			10000
		);

		return (...args) =>
		{
			if (called)
				return;
			called = true;
			clearTimeout(interval);

			callback(...args);
		};
	}

	_request(socket, method, data = {})
	{
		return new Promise((resolve, reject) =>
		{
			socket.emit(
				'request',
				{ method, data },
				this._timeoutCallback((err, response) =>
				{
					if (err)
					{
						reject(err);
					}
					else
					{
						resolve(response);
					}
				})
			);
		});
	}

	_notification(socket, method, data = {}, broadcast = false)
	{
		if (broadcast)
		{
			socket.broadcast.to(this._roomId).emit(
				'notification', { method, data }
			);
		}
		else
		{
			socket.emit('notification', { method, data });
		}
	}
}

module.exports = Room;
