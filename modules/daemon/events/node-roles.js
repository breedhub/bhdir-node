/**
 * Node Roles event
 * @module daemon/events/node-roles
 */
const fs = require('fs');
const uuid = require('uuid');
const WError = require('verror').WError;

/**
 * Node Roles event class
 */
class NodeRoles {
    /**
     * Create service
     * @param {App} app                             The application
     * @param {object} config                       Configuration
     * @param {Logger} logger                       Logger service
     */
    constructor(app, config, logger) {
        this._app = app;
        this._config = config;
        this._logger = logger;
    }

    /**
     * Service name is 'modules.daemon.events.nodeRoles'
     * @type {string}
     */
    static get provides() {
        return 'modules.daemon.events.nodeRoles';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'logger' ];
    }

    /**
     * Event handler
     * @param {string} id           ID of the client
     * @param {object} message      The message
     */
    handle(id, message) {
        let client = this.daemon.clients.get(id);
        if (!client)
            return;

        this._logger.debug('role-add', `Got ROLE ADD command`);
        let reply = (success, value) => {
            let reply = {
                id: message.id,
                success: success,
            };
            if (!success)
                reply.message = value;
            let data = Buffer.from(JSON.stringify(reply), 'utf8');
            this._logger.debug('role-add', `Sending ROLE ADD response`);
            this.daemon.send(id, data);
        };

        if (message.args.length !== 3)
            return reply(false, 'Invalid arguments list');

        if (this.syncthing.roles.indexOf('coordinator') === -1)
            return reply(false, 'We are not a coordinator');

        let nodeId = message.args[0];
        let toAdd = new Set(message.args[1]);
        let toRemove = new Set(message.args[2]);
        for (let role of message.args[1].concat(message.args[2])) {
            if (this.syncthing.constructor.roles.indexOf(role) === -1)
                return reply(false, 'Invalid role');
        }

        new Promise((resolve, reject) => {
                if (!this.syncthing.node)
                    return reject(new Error('bhdir is not installed'));

                try {
                    fs.accessSync('/var/lib/bhdir/.core/data/home/.vars.json', fs.constants.F_OK);
                    resolve();
                } catch (error) {
                    reject(new Error('We are not part of a network'));
                }
            })
            .then(() => {
                return Array.from(toAdd).reduce(
                    (prev, cur) => {
                        return prev.then(() => {
                            return this.syncthing.addRole(nodeId, cur);
                        });
                    },
                    Promise.resolve()
                );
            })
            .then(() => {
                return Array.from(toRemove).reduce(
                    (prev, cur) => {
                        return prev.then(() => {
                            return this.syncthing.removeRole(nodeId, cur);
                        });
                    },
                    Promise.resolve()
                )
            })
            .then(() => {
                reply(true);
            })
            .catch(error => {
                reply(false, error.message);
                this._logger.error(new WError(error, 'NodeRoles.handle()'));
            });
    }

    /**
     * Retrieve daemon server
     * @return {Daemon}
     */
    get daemon() {
        if (this._daemon)
            return this._daemon;
        this._daemon = this._app.get('servers').get('daemon');
        return this._daemon;
    }

    /**
     * Retrieve directory server
     * @return {Directory}
     */
    get directory() {
        if (this._directory)
            return this._directory;
        this._directory = this._app.get('servers').get('directory');
        return this._directory;
    }

    /**
     * Retrieve syncthing server
     * @return {Syncthing}
     */
    get syncthing() {
        if (this._syncthing)
            return this._syncthing;
        this._syncthing = this._app.get('servers').get('syncthing');
        return this._syncthing;
    }
}

module.exports = NodeRoles;