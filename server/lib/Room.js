const EventEmitter = require('events').EventEmitter;
const AwaitQueue = require('awaitqueue');
const axios = require('axios');
const Logger = require('./Logger');
const { SocketTimeoutError } = require('./errors');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const userRoles = require('../userRoles');


const permissions = require('../permissions'), {
	CHANGE_ROOM_LOCK,
	PROMOTE_PEER,
	SEND_CHAT,
	MODERATE_CHAT,
	SHARE_SCREEN,
	EXTRA_VIDEO,
	SHARE_FILE,
	MODERATE_FILES,
	MODERATE_ROOM
} = permissions;

const config = require('../config/config');

const logger = new Logger('Room');

const roomsMap = new Map();
const uberProducers = new Map();


const roomPermissions =
{
	[CHANGE_ROOM_LOCK] : [ userRoles.NORMAL ],
	[PROMOTE_PEER]     : [ userRoles.NORMAL ],
	[SEND_CHAT]        : [ userRoles.NORMAL ],
	[MODERATE_CHAT]    : [ userRoles.MODERATOR ],
	[SHARE_SCREEN]     : [ userRoles.NORMAL ],
	[EXTRA_VIDEO]      : [ userRoles.NORMAL ],
	[SHARE_FILE]       : [ userRoles.NORMAL ],
	[MODERATE_FILES]   : [ userRoles.MODERATOR ],
	[MODERATE_ROOM]    : [ userRoles.MODERATOR ],
	...config.permissionsFromRoles
};

const roomAllowWhenRoleMissing = config.allowWhenRoleMissing || [];

const ROUTER_SCALE_SIZE = config.routerScaleSize || 40;
const MAX_CONSUMERS_PER_WORKER = 400;

class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorkers - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorkers, roomId })
	{
		logger.info('create() [roomId:"%s"]', roomId);

		// Router media codecs.
		const mediaCodecs = config.mediasoup.router.mediaCodecs;

		const mediasoupRouters = new Map();

		for (const worker of mediasoupWorkers) {
			const router = await worker.createRouter({ mediaCodecs });
			router.workerLink = worker;
			mediasoupRouters.set(router.id, router);
			logger.info('[roomId:%s] create router %s', roomId, router.id);
		}

		const room = new Room({
			roomId,
			mediasoupRouters,
		});

		room.on("close", () => {
			logger.info('room close [roomId:"%s"]', roomId);
			roomsMap.delete(roomId);
		});

		roomsMap.set(roomId, room);

		logger.info('create() [roomId:"%s"] success', roomId);

		return room;
	}

	constructor({ roomId, mediasoupRouters })
	{
		logger.info('constructor() [roomId:"%s"]', roomId);

		super();

		this.setMaxListeners(Infinity);

		this._uuid = uuidv4();

		// Room ID.
		this._roomId = roomId;

		// Closed flag.
		this._closed = false;

		// Joining queue
		this._queue = new AwaitQueue();

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

		this._selfDestructTimeout = null;

		// Array of mediasoup Router instances.
		this._mediasoupRouters = mediasoupRouters;

		this._pipeUberProducerCache = {};

		const newRouterId = this._getLeastLoadedRouter();
		this._currentRouter = this._mediasoupRouters.get(newRouterId)
	}

	async getRouterRtpCapabilities() {
		const routerId = await this._getRouterId();
		const router = this._mediasoupRouters.get(routerId);
		return router.rtpCapabilities;
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
		logger.info('createBroadcaster() [roomId:%s id:%s name:%s] create router %s', this._roomId, id, displayName);

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

		if (!broadcaster.routerId) {
			broadcaster.routerId = await this._getRouterId();
		}

		const router = this._mediasoupRouters.get(broadcaster.routerId);

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
						!router.canConsume(
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

		if (!broadcaster.routerId) {
			broadcaster.routerId = await this._getRouterId();
		}

		const router = this._mediasoupRouters.get(broadcaster.routerId);

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

				const transport = await router.createPlainTransport(
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
			console.log(broadcaster.id, "create consumer for ", peer)
			this._createConsumer(
				{
					consumerPeer : peer,
					producerPeer : broadcaster,
					consumerPriority: 100,
					producer,
				}).catch(() => {});
		}

		return { id: producer.id };
	}

	close()
	{
		logger.debug('close()');

		this._closed = true;

		this._queue.close();

		this._queue = null;

		if (this._selfDestructTimeout)
			clearTimeout(this._selfDestructTimeout);

		this._selfDestructTimeout = null;

		// Close the peers.
		for (const peer in this._peers)
		{
			if (!this._peers[peer].closed)
				this._peers[peer].close();
		}

		this._peers = null;

		// Close the mediasoup Routers.
		for (const router of this._mediasoupRouters.values())
		{
			router.close();
		}

		this._routerIterator = null;

		this._currentRouter = null;

		this._mediasoupRouters.clear();

		this._pipeUberProducerCache = null;

		// Emit 'close' event.
		this.emit('close');
	}

	verifyPeer({ id, token })
	{
		try
		{
			const decoded = jwt.verify(token, this._uuid);

			logger.info('verifyPeer() [decoded:"%o"]', decoded);

			return decoded.id === id;
		}
		catch (err)
		{
			logger.warn('verifyPeer() | invalid token');
		}

		return false;
	}

	handlePeer({ peer, returning })
	{
		logger.info('handlePeer() [peer:"%s", roles:"%s", returning:"%s"]', peer.id, peer.roles, returning);

		// Should not happen
		if (this._peers[peer.id])
		{
			logger.warn(
				'handleConnection() | there is already a peer with same peerId [peer:"%s"]',
				peer.id);
		}

		this._peerJoining(peer, returning);
	}

	dump()
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

		if (this._selfDestructTimeout)
			clearTimeout(this._selfDestructTimeout);

		this._selfDestructTimeout = setTimeout(() =>
		{
			if (this._closed)
				return;

			if (this.checkEmpty())
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

	checkEmpty()
	{
		return Object.keys(this._peers).length === 0;
	}

	_peerJoining(peer, returning = false)
	{
		this._queue.push(async () =>
		{
			peer.socket.join(this._roomId);

			// If we don't have this peer, add to end
			!this._lastN.includes(peer.id) && this._lastN.push(peer.id);

			this._peers[peer.id] = peer;

			// Assign routerId
			peer.routerId = await this._getRouterId();

			this._registerPeerOnWorker(this._mediasoupRouters.get(peer.routerId), peer.id);
			logger.info('_peerJoining() assign router [roomId:%s peerId:%s routerId:%s]', this._roomId, peer.id, peer.routerId);

			this._handlePeer(peer);

			if (returning) {
				this._notification(peer.socket, 'roomBack');
			}
			else
			{
				this._notification(peer.socket, 'roomReady');
			}
		})
			.catch((error) =>
			{
				logger.error('_peerJoining() [error:"%o"]', error);
			});
	}

	_handlePeer(peer)
	{
		logger.debug('_handlePeer() [peer:"%s"]', peer.id);

		peer.on('close', () =>
		{
			this._handlePeerClose(peer);
		});

		peer.socket.on('request', (request, cb) =>
		{
			logger.debug(
				'Peer "request" event [roomId:"%s" method:"%s", peerId:"%s"]',
				this._roomId, request.method, peer.id);

			this._handleSocketRequest(peer, request, cb)
				.catch((error) =>
				{
					logger.error('"request" failed [error:"%o"]', error);

					cb(error);
				});
		});

		// Peer left before we were done joining
		if (peer.closed)
			this._handlePeerClose(peer);
	}

	_handlePeerClose(peer)
	{
		logger.debug('_handlePeerClose() [peer:"%s"]', peer.id);

		if (this._closed)
			return;

		// If the Peer was joined, notify all Peers.
		if (peer.joined)
			this._notification(peer.socket, 'peerClosed', { peerId: peer.id }, true);

		// Remove from lastN
		this._lastN = this._lastN.filter((id) => id !== peer.id);

		delete this._peers[peer.id];

		this._deletePeerFromWorker(this._mediasoupRouters.get(peer.routerId), peer.id);

		// If this is the last Peer in the room and
		// lobby is empty, close the room after a while.
		if (this.checkEmpty()) this.selfDestructCountdown();
	}

	async _handleSocketRequest(peer, request, cb)
	{
		const router = this._mediasoupRouters.get(peer.routerId);

		switch (request.method)
		{
			case 'getRouterRtpCapabilities':
			{
				cb(null, router.rtpCapabilities);

				break;
			}

			case 'join':
			{
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

				const joinedPeers = this._getJoinedPeers(peer);

				const peerInfos = joinedPeers
					.map((joinedPeer) => (joinedPeer.peerInfo));

				cb(null, {
					roles                : peer.roles,
					peers                : peerInfos,
					authenticated        : peer.authenticated,
					roomPermissions      : roomPermissions,
					userRoles            : userRoles,
					allowWhenRoleMissing : roomAllowWhenRoleMissing,
					lastNHistory         : this._lastN,
				});

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
						// console.log("add producer", producer.id, producer)
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : broadcaster,
								consumerPriority: 100,
								producer,
							}).catch(() => {});
					}
				}

				// TODO: create consumers for each uber producer
				for (let [producerId, uberProducer] of uberProducers) {
					const { producerPeer, producer, router, roomIds } = uberProducer;

					if (!roomIds.includes(this._roomId)) continue;

					console.log("create consumers for uber producer", this._roomId, peer.id);

                    this.pipeToRouter(producerId, peer, 2);
				}


				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers(peer))
				{
					this._notification(
						otherPeer.socket,
						'newPeer',
						{
							id          : peer.id,
							displayName : displayName,
							picture     : picture,
							roles       : peer.roles
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

				const transport = await router.createWebRtcTransport(
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
				let { appData } = request.data;

				let { roomIds } = appData;
				const isUberProducer = roomIds && roomIds.length > 1;
				if (isUberProducer) {
					roomIds = roomIds.filter(roomId => roomId !== this._roomId);
				}

				// Ensure the Peer is joined.
				if (!peer.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				const transport = peer.getTransport(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				// Add peerId into appData to later get the associated Peer during
				// the 'loudest' event of the audioLevelObserver.
				appData = { ...appData, peerId: peer.id };

				const producer =
					await transport.produce({ kind, rtpParameters, appData });

				const pipeRouters = this._getRoutersToPipeTo(peer.routerId);

				for (const [ routerId, destinationRouter ] of this._mediasoupRouters)
				{
					if (pipeRouters.includes(routerId))
					{
						await router.pipeToRouter({
							producerId : producer.id,
							router     : destinationRouter
						});
					}
				}

				// Store the Producer into the Peer data Object.
				peer.addProducer(producer.id, producer);

				// Set Producer events.
				// producer.on('score', (score) =>
				// {
				// 	this._notification(peer.socket, 'producerScore', { producerId: producer.id, score });
				// });

				producer.on('videoorientationchange', (videoOrientation) =>
				{
					logger.debug(
						'producer "videoorientationchange" event [producerId:"%s", videoOrientation:"%o"]',
						producer.id, videoOrientation);
				});

				cb(null, { id: producer.id });

				// Optimization: Create a server-side Consumer for each Peer.
				for (const otherPeer of this._getJoinedPeers(peer)) {
					this._createConsumer({
						consumerPeer : otherPeer,
						producerPeer : peer,
						producer
					});
				}

				// UBER
				if (isUberProducer && roomIds.length) {
					console.log("set up uber producer", roomIds);

					const router = this._mediasoupRouters.get(peer.routerId);

					uberProducers.set(producer.id, {
						producerPeer: peer,
						producer,
						router,
						roomIds,
					});

					for (let roomId of roomIds) {
						const room = roomsMap.get(roomId);

						console.log("room", roomId, Boolean(room));

						if (!room) {
							logger.error(`[uber producer] room=${roomId} is not found`);
							continue;
						}

						await room.createConsumersForUberProducer(producer.id);
					}
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
					throw new Error(`closeProducer producer with id "${producerId}" not found`);

				producer.close();

				if (uberProducers.get(producer.id)) {
					uberProducers.delete(producer.id);
				}

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
					throw new Error(`pauseProducer producer with id "${producerId}" not found`);

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
					throw new Error(`resumeProducer producer with id "${producerId}" not found`);

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
					throw new Error(`pauseConsumer consumer with id "${consumerId}" not found`);

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
					throw new Error(`resumeConsumer consumer with id "${consumerId}" not found`);

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
					throw new Error(`requestConsumerKeyFrame consumer with id "${consumerId}" not found`);

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
					throw new Error(`getProducerStats producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				cb(null, stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.getConsumer(consumerId);

				if (!consumer)
					throw new Error(`getConsumerStats consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				cb(null, stats);

				break;
			}

			case 'startSpeaking':
			{
				const { peerId } = request.data;

				for (const peer of this._getJoinedPeers())
				{
					if (peer.id === peerId) continue;

					this._notification(
						peer.socket,
						'startSpeaking',
						{
							peerId : peerId,
						});
				}

				cb();

				break;
			}

			case 'stopSpeaking':
			{
				const { peerId } = request.data;

				for (const peer of this._getJoinedPeers())
				{
					if (peer.id === peerId) continue;

					this._notification(
						peer.socket,
						'stopSpeaking',
						{
							peerId : peerId,
						});
				}

				cb();

				break;
			}

			case 'clientBug': {
				let output = "";
				output += `\n\n\nCLIENT_BUG roomId=${this.id} peerId=${peer.id} name=${peer.displayName} routerId=${peer.routerId}`;

				const peers = this._getJoinedPeers();
				for (let peer of peers) {

					const router = this._mediasoupRouters.get(peer.routerId);
					const worker = router.workerLink;
					output += `\n\n>>>Peer ${peer.id} worker=${worker.pid} \n`;

					for (const [producerId, producer] of peer.producers.entries()) {
						output += `\nProducer id=${producerId} kind=${producer.kind} paused=${producer.paused} closed=${producer.closed}`;
						output += "\nScore: " + JSON.stringify(producer.score);
						const stats = await producer.getStats();
						output += "\nStats: " + JSON.stringify(stats);
						output += "\n";
					}

					for (const [consumerId, consumer] of peer.consumers.entries()) {
						output += `\nConsumer id=${consumerId} kind=${consumer.kind} paused=${consumer.paused} closed=${consumer.closed}`;
						output += "\nScore: " + JSON.stringify(consumer.score);
						const stats = await consumer.getStats();
						output += "\nStats: " + JSON.stringify(stats);
						output += "\n";
					}

					output += "\n>>>EndPeer " + peer.id + "\n\n";
				}

				output += "\n\n\n";

				console.log(output);

				cb(null, {
					output,
				});


				break;
			}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				cb(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	markRouterUberProducer(producerId, routerId) {
		this._pipeUberProducerCache[producerId + "_" + routerId] = true;
	}

	isRouterHasUberProducer(producerId, routerId) {
		return Boolean(this._pipeUberProducerCache[producerId + "_" + routerId]);
	}

	async createConsumersForUberProducer(producerId) {
		const uberProducer = uberProducers.get(producerId);

		console.log("createConsumersForUberProducer from room", this._roomId, producerId, Boolean(uberProducer));

		if (!uberProducer) {
			logger.error(`[createConsumersForUberProducer] fail producer=${producerId} is not found`);
			return;
		}

		const { producerPeer, producer, router } = uberProducer;

		const peers = this._getJoinedPeers();
		console.log("peers", peers.length);
		const routerIds = [];
		for (let peer of peers) {
			if (!routerIds.includes(peer.routerId)) {
				routerIds.push(peer.routerId);
			}
		}

		for (const [ routerId, destinationRouter ] of this._mediasoupRouters) {
			if (this.isRouterHasUberProducer(producerId, routerId)) {
				continue;
			}

			if (routerIds.includes(routerId)) {
				await router.pipeToRouter({
					producerId: producer.id,
					router: destinationRouter
				});

				this.markRouterUberProducer(producerId, routerId);
			}
		}

		for (let peer of peers) {
			this._createConsumer({
				consumerPeer: peer,
				consumerPriority: 255,
				producerPeer: producerPeer,
				producer,
				router,
			});
		}
	}

	pipeToRouter(producerId, peer, repeat = 0) {
		const uberProducer = uberProducers.get(producerId);

		if (!uberProducer) return;

		const { producerPeer, producer, router, roomIds } = uberProducer;

		if (this.isRouterHasUberProducer(producerId, this._currentRouter.id)) {
			this._createConsumer(
				{
					consumerPeer : peer,
					producerPeer : producerPeer,
					consumerPriority: 255,
					router,
					producer,
				}).catch(() => {});

			return ;
		}

        console.log("not piped, pipe");

        let timer = setTimeout(() => {
            if (repeat > 0) {
                this.pipeToRouter(producerId, peer, repeat - 1);
            }
        }, 1000);

        router.pipeToRouter({
            producerId,
            router: this._currentRouter
        }).then(() => {
            console.log("piped!!");

            clearTimeout(timer);

            this.markRouterUberProducer(producerId, this._currentRouter.id);

            this._createConsumer(
                {
                    consumerPeer : peer,
                    producerPeer : producerPeer,
					consumerPriority: 255,
                    router,
                    producer,
                }).catch(() => {});
        }).catch((e) => {
        	console.error("pipeTo Uber Router error", e);
		});

	}


	/**
	 * Creates a mediasoup Consumer for the given mediasoup Producer.
	 *
	 * @async
	 */
	async _createConsumer({ consumerPeer, producerPeer, producer, consumerPriority, router })
	{
		logger.debug(
			'_createConsumer() [consumerPeer:"%s", producerPeer:"%s", producer:"%s"]',
			consumerPeer.id,
			producerPeer.id,
			producer.id
		);

		if (!router) {
			router = this._mediasoupRouters.get(producerPeer.routerId);
		}

		logger.debug('_createConsumer router:"%s"', router.id);

		// Optimization:
		// - Create the server-side Consumer. If video, do it paused.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		const routerCantConsume = !router.canConsume({
			producerId: producer.id,
			rtpCapabilities: consumerPeer.rtpCapabilities
		});

		if (!consumerPeer.rtpCapabilities || routerCantConsume) {
			logger.error(`[_createConsumer] fail routerCantConsume=${routerCantConsume} noRtpCapabilities=${!consumerPeer.rtpCapabilities}`);
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = consumerPeer.getConsumerTransport();

		// This should not happen.
		if (!transport)
		{
			logger.error('_createConsumer() | Transport for consuming not found');

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
					paused          : true,//producer.kind === 'video'
				});

			this._registerConsumerOnWorker(router, consumer.id);

			let priority = 150;

			if (producer.kind === 'audio') {
				priority = 200;
			}

			if (consumerPriority) {
				priority = consumerPriority;
			}

			await consumer.setPriority(priority);
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
			logger.info('_createConsumer() | transportclose consumerId="%s"', consumer.id);
			// Remove from its map.
			consumerPeer.removeConsumer(consumer.id);
			this._deleteConsumerFromWorker(router, consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			logger.info('_createConsumer() | producerclose consumerId="%s"', consumer.id);
			// Remove from its map.
			consumerPeer.removeConsumer(consumer.id);
			this._deleteConsumerFromWorker(router, consumer.id);

			this._notification(consumerPeer.socket, 'consumerClosed', { consumerId: consumer.id });
		});

		consumer.on('producerpause', () =>
		{
			logger.info('_createConsumer() | producerpause consumerId="%s"', consumer.id);
			this._notification(consumerPeer.socket, 'consumerPaused', { consumerId: consumer.id });
		});

		consumer.on('producerresume', () =>
		{
			logger.info('_createConsumer() | producerresume consumerId="%s"', consumer.id);
			this._notification(consumerPeer.socket, 'consumerResumed', { consumerId: consumer.id });
		});

		// consumer.on('score', (score) =>
		// {
		// 	this._notification(consumerPeer.socket, 'consumerScore', { consumerId: consumer.id, score });
		// });

		consumer.on('layerschange', (layers) =>
		{
			logger.info('_createConsumer() | layerschange consumerId="%s"', consumer.id);
		// 	this._notification(
		// 		consumerPeer.socket,
		// 		'consumerLayersChanged',
		// 		{
		// 			consumerId    : consumer.id,
		// 			spatialLayer  : layers ? layers.spatialLayer : null,
		// 			temporalLayer : layers ? layers.temporalLayer : null
		// 		}
		// 	);
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
			// await consumer.resume();

			// this._notification(
			// 	consumerPeer.socket,
			// 	'consumerScore',
			// 	{
			// 		consumerId : consumer.id,
			// 		score      : consumer.score
			// 	}
			// );
		}
		catch (error)
		{
			logger.warn('_createConsumer() | [error:"%o"]', error);
		}
	}

	/**
	 * Helper to get the list of joined peers.
	 */
	_getJoinedPeers(excludePeer = undefined)
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
				callback(new SocketTimeoutError('Request timed out'));
			},
			config.requestTimeout || 20000
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

	_sendRequest(socket, method, data = {})
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

	async _request(socket, method, data)
	{
		logger.debug('_request() [method:"%s", data:"%o"]', method, data);

		const {
			requestRetries = 3
		} = config;

		for (let tries = 0; tries < requestRetries; tries++)
		{
			try
			{
				return await this._sendRequest(socket, method, data);
			}
			catch (error)
			{
				if (
					error instanceof SocketTimeoutError &&
					tries < requestRetries
				)
					logger.warn('_request() | timeout, retrying [attempt:"%s"]', tries);
				else
					throw error;
			}
		}
	}

	_notification(socket, method, data = {}, broadcast = false, includeSender = false)
	{
		if (broadcast)
		{
			socket.broadcast.to(this._roomId).emit(
				'notification', { method, data }
			);

			if (includeSender)
				socket.emit('notification', { method, data });
		}
		else
		{
			socket.emit('notification', { method, data });
		}
	}

	async _pipeProducersToNewRouter() {
		console.log("_pipeProducersToNewRouter");

		const peersToPipe =
			Object.values(this._peers)
				.filter((peer) => peer.routerId !== this._currentRouter.id);

		for (const peer of peersToPipe) {
			const srcRouter = this._mediasoupRouters.get(peer.routerId);

			for (const producerId of peer.producers.keys()) {
				await srcRouter.pipeToRouter({
					producerId,
					router : this._currentRouter
				});
			}
		}

		for (let [producerId, uberProducer] of uberProducers) {
			const { producerPeer, producer, router, roomIds } = uberProducer;

			if (!roomIds.includes(this._roomId)) continue;

			if (this.isRouterHasUberProducer(producerId, this._currentRouter.id)) {
				continue;
			}

			console.log("pip uber producer to new router", router, this._currentRouter);

			await router.pipeToRouter({
				producerId,
				router : this._currentRouter
			});

			this.markRouterUberProducer(producerId, this._currentRouter.id)
		}
	}

	async _getRouterId() {
		if (!this._currentRouter) {
			throw new Error(("_getRouterId Error - _currentRouter is not defined"));
		}

		const routerLoad = this._getRouterLoad(this._currentRouter);

		if (routerLoad >= MAX_CONSUMERS_PER_WORKER) {
			const currentRouterId = this._currentRouter.id;
			const newRouterId = this._getLeastLoadedRouter();

			if (currentRouterId !== newRouterId) {
				this._currentRouter = this._mediasoupRouters.get(newRouterId);
				await this._pipeProducersToNewRouter();
			}
		}

		return this._currentRouter.id;
	}

	// Returns an array of router ids we need to pipe to
	_getRoutersToPipeTo(originRouterId) {
		return Object.values(this._peers)
			.map((peer) => peer.routerId)
			.filter((routerId, index, self) =>
				routerId !== originRouterId && self.indexOf(routerId) === index
			);
	}

	_getLeastLoadedRouter() {
		let load = Infinity;
		let id;

		for (const routerId of this._mediasoupRouters.keys()) {
			const router = this._mediasoupRouters.get(routerId);

			let currentLoad = this._getRouterLoad(router);

			if (currentLoad < load) {
				id = routerId;
				load = currentLoad;
			}
		}

		return id;
	}

	_registerConsumerOnWorker(router, consumerId) {
		const worker = router.workerLink;

		if (worker.realConsumers === undefined) {
			worker.realConsumers = [];
		}

		if (!worker.realConsumers.includes(consumerId)) {
			worker.realConsumers.push(consumerId);
		}
	}

	_deleteConsumerFromWorker(router, consumerId) {
		const worker = router.workerLink;

		if (worker.realConsumers === undefined) {
			worker.realConsumers = [];
		}

		let index = worker.realConsumers.indexOf(consumerId);
		if (index !== -1) {
			worker.realConsumers.splice(index, 1);
		}
	}

	_registerPeerOnWorker(router, peerId) {
		const worker = router.workerLink;

		if (!worker.realPeers.includes(peerId)) {
			worker.realPeers.push(peerId);
		}
	}

	_deletePeerFromWorker(router, peerId) {
		const worker = router.workerLink;

		let index = worker.realPeers.indexOf(peerId);
		if (index !== -1) {
			worker.realPeers.splice(index, 1);
		}
	}

	_getRouterLoad(router) {
		const worker = router.workerLink;

		let currentLoad = 0;

		// if (worker.realConsumers && worker.realConsumers.length) {
		// 	currentLoad = worker.realConsumers.length;
		// }

		// if (worker.realPeers && worker.realPeers.length) {
			// let lastN = 8;
			// let peerNum = worker.realPeers.length;
			// if (lastN > peerNum) lastN = peerNum;
			// currentLoad = (peerNum + peerNum) * (peerNum - 1);
			// currentLoad = peerNum * 50;
		// }

		return currentLoad;
	}
}

module.exports = Room;
