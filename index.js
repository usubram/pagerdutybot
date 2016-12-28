'use strict';

const SlackBot = require('slack-quick-bots');
const handlebars = require('handlebars');
const path = require('path');
const fs = require('fs');
const template = fs.readFileSync(path.join(__dirname, 'template/oncall-template.hbs'), 'utf8');
const service = require('./lib/service');

const args = process.argv.slice(2);
const apikey = args[1];

var config = {
  bots: [{
    botCommand: {
      team: {
        commandType: 'DATA',
        allowedParam: ['*'],
        helpText: '_Usage: team team-name (full or part of team name)_ \\n',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getTeams(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      },
      escalation: {
        commandType: 'DATA',
        allowedParam: ['*'],
        helpText: '_Usage: escalation escalation-name (full or part of escalation name)_ \\n',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getEscalations(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      },
      oncall: {
        commandType: 'DATA',
        allowedParam: ['primary', 'secondary', 'all'],
        helpText: '_Usage: oncall primary escalation-name (full or part of escalation name)_ \\n',
        template: function() {
          return handlebars.compile(template);
        },
        data: function(input, options, callback) {
          service.getOnCall(input.params, apikey, function(err, data) {
            callback({ result: data });
          });
        }
      }
    },
    schedule: true,
    botToken: args[0] || ''
  }]
};

var slackBot = new SlackBot(config);
slackBot.start();
