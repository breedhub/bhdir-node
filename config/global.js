/**
 * Repo-saved application configuration
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');

let userConfig;
try {
    userConfig = ini.parse(fs.readFileSync(os.platform() === 'freebsd' ? '/usr/local/etc/bhdir/bhdir.conf' : '/etc/bhdir/bhdir.conf', 'utf8'));
} catch (error) {
    userConfig = {};
}

module.exports = {
    // Project name (alphanumeric)
    project: 'bhdir',

    // Server instance name (alphanumeric)
    instance: 'daemon',

    // Environment
    env: process.env.NODE_ENV || 'production',

    // Load base classes and services, path names
    autoload: [
        '!src/servers',
        '!src/services',
        'commands',
        'servers',
    ],

    // Loaded modules
    modules: [
        'daemon'
    ],

    // Servers
    servers: {
        directory: {
            class: 'servers.directory',
        },
        daemon: {
            class: 'servers.daemon',
        },
        state: {
            class: 'servers.state',
        },
        index: {
            class: 'servers.index',
        },
        resilio: {
            class: 'servers.resilio',
        },
        syncthing: {
            class: 'servers.syncthing',
        },
    },

    // Redis servers
    redis: {
        main: {
            host: userConfig.redis && userConfig.redis.host,
            port: userConfig.redis && userConfig.redis.port,
            password: userConfig.redis && userConfig.redis.password,
        },
    },

    // SMTP servers
    smtp: {
        main: {
            host: 'localhost',
            port: 25,
            ssl: false,
            //user: 'username',
            //password: 'password',
        },
    },

    email: {
        from: 'root@localhost',
        log: {
            enable: false,                 // email logger messages or not
            level: 'error',
            to: 'debug@example.com',
        },
        crash: {
            enable: false,                 // email program crash or not
            to: 'debug@example.com',
        },
    },

    cache: {
        enable: true,
        redis: 'main',                      // Name of Redis configuration to use
        expire_min: parseInt((userConfig.directory && userConfig.directory.cache_ttl) || 500),
        expire_max: parseInt((userConfig.directory && userConfig.directory.cache_ttl) || 500),
    },

    logs: {
        main: {
            level: (userConfig.daemon && userConfig.daemon.log_level) || 'info',
            default: true,
            name: 'bhdir.log',
            path: '/var/log/bhdir',
            interval: '1d',
            mode: 0o640,
        },
        syncthing: {
            level: 'info',
            name: 'syncthing.log',
            path: '/var/log/bhdir',
            interval: '1d',
            mode: 0o640,
        },
    },

/*
     user: { // Drop privileges, otherwise comment out this section
     uid: 'www',
     gid: 'www',
     },
*/
};
