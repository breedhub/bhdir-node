/**
 * Set command
 * @module commands/set
 */
const path = require('path');
const net = require('net');
const uuid = require('uuid');
const SocketWrapper = require('socket-wrapper');

/**
 * Command class
 */
class Set {
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
     * Service name is 'commands.set'
     * @type {string}
     */
    static get provides() {
        return 'commands.set';
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
        if (argv['_'].length < 3)
            return this._help.helpSet(argv);

        let setPath = argv['_'][1];
        let setValue = argv['_'][2];
        let sockName = argv['z'];

        switch (argv['t'] || 'string') {
            case 'string':
                break;
            case 'number':
                try {
                    setValue = parseFloat(setValue);
                } catch (error) {
                    this.error(`Could not parse number: ${error.message}`);
                }
                break;
            case 'boolean':
                setValue = (setValue.toLowerCase() === 'true');
                break;
            case 'json':
                try {
                    setValue = JSON.parse(setValue);
                } catch (error) {
                    this.error(`Could not parse JSON: ${error.message}`);
                }
                break;
            default:
                this.error('Invalid type');
        }

        let request = {
            id: uuid.v1(),
            command: 'set',
            args: [
                setPath,
                setValue
            ]
        };

        return this.send(Buffer.from(JSON.stringify(request), 'utf8'), sockName)
            .then(reply => {
                let response = JSON.parse(reply.toString());
                if (response.id !== request.id)
                    throw new Error('Invalid reply from daemon');

                if (!response.success)
                    throw new Error(`Error: ${response.message}`);

                process.exit(0);
            })
            .catch(error => {
                return this.error(error.message);
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
            if (sockName && sockName[0] === '/')
                sock = sockName;
            else
                sock = path.join('/var', 'run', this._config.project, this._config.instance + (sockName || '') + '.sock');

            let onError = error => {
                this.error(`Could not connect to daemon: ${error.message}`);
            };

            let socket = net.connect(sock, () => {
                this._app.debug('Connected to daemon');
                socket.removeListener('error', onError);
                socket.once('error', error => { this.error(error.message) });

                let wrapper = new SocketWrapper(socket);
                wrapper.on('receive', data => {
                    this._app.debug('Got daemon reply');
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
        if (args.length)
            args[args.length - 1] = args[args.length - 1] + '\n';

        return this._app.error(...args)
            .then(
                () => {
                    process.exit(1);
                },
                () => {
                    process.exit(1);
                }
            );
    }
}

module.exports = Set;