/**
 * Touch command
 * @module commands/touch
 */
const debug = require('debug')('bhdir:command');
const path = require('path');
const net = require('net');
const uuid = require('uuid');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Touch {
    /**
     * Create the service
     * @param {App} app                 The application
     * @param {object} config           Configuration
     * @param {Help} help               Help command
     */
    constructor(app, config, help) {
        this._app = app;
        this._config = config;
        this._help = help;
    }

    /**
     * Service name is 'commands.touch'
     * @type {string}
     */
    static get provides() {
        return 'commands.touch';
    }

    /**
     * Dependencies as constructor arguments
     * @type {string[]}
     */
    static get requires() {
        return [ 'app', 'config', 'commands.help' ];
    }

    /**
     * Run the command
     * @param {object} argv             Minimist object
     * @return {Promise}
     */
    run(argv) {
        if (argv['_'].length < 2)
            return this._help.helpGet(argv);

        let touchPath = argv['_'][1];
        let sockName = argv['z'];

        let request = {
            id: uuid.v1(),
            command: 'touch',
            args: [
                touchPath,
            ]
        };

        return this.send(Buffer.from(JSON.stringify(request), 'utf8'), sockName)
            .then(reply => {
                let response = JSON.parse(reply.toString());
                if (response.id != request.id)
                    throw new Error('Invalid reply from daemon');

                if (!response.success)
                    this.error(`Error: ${response.message}`);

                process.exit(0);
            })
            .catch(error => {
                this.error(error.message);
            });
    }

    /**
     * Send request and return response
     * @param {Buffer} request
     * @param {string} [sockName]
     * @return {Promise}
     */
    send(request, sockName) {
        return new Promise((resolve, reject) => {
            let sock;
            if (sockName && sockName[0] == '/')
                sock = sockName;
            else
                sock = path.join('/var', 'run', this._config.project, this._config.instance + (sockName || '') + '.sock');

            let onError = error => {
                this.error(`Could not connect to daemon: ${error.message}`);
            };

            let socket = net.connect(sock, () => {
                debug('Connected to daemon');
                socket.removeListener('error', onError);
                socket.once('error', error => { this.error(error.message) });

                let wrapper = new SocketWrapper(socket);
                wrapper.on('receive', data => {
                    debug('Got daemon reply');
                    resolve(data);
                    socket.end();
                });
                wrapper.send(request);
            });
            socket.on('error', onError);
        });
    }

    /**
     * Log error and terminate
     * @param {...*} args
     */
    error(...args) {
        console.error(...args);
        process.exit(1);
    }
}

module.exports = Touch;