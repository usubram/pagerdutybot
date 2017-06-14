'use strict';

const _ = require('lodash');
const async = require("async");
const http = require('https');

const pagerdutyApi = 'api.pagerduty.com';
const concurrentRate = 3;
const searchLimit = 3;
const internals = {
  apiKey: ''
};

var requestQueue = {};

module.exports.getTeams = function (params, apiKey, callback) {
  internals.apiKey = apiKey;
  const searchStrArr = _.slice(params, 0, (params || []).length);
  const searchStr = _.trim(_.join(searchStrArr, ' '));
  const searchKey = encodeURIComponent(searchStr);

  if (internals.minLenValidation(searchStr)) {
    return callback(null, { min_len_err: true });
  }

  internals.queueCall(internals.fetchTeams(searchKey), function (err, result) {
    if (err || _.get(result, 'teams', []).length === 0) {
      return callback(null, { not_found: true })
    }
    callback(null, result);
  });
};

module.exports.getEscalations = function (params, apiKey, callback) {
  internals.apiKey = apiKey;

  const searchStrArr = _.slice(params, 0, (params || []).length);
  const searchStr = _.trim(_.join(searchStrArr, ' '));
  const searchKey = encodeURIComponent(searchStr);

  if (internals.minLenValidation(searchStr)) {
    return callback(null, { min_len_err: true });
  }

  internals.queueCall(internals.fetchEscalations(searchKey), function (err, result) {
    if (err || _.get(result, 'escalation_policies', []).length === 0) {
      return callback(null, { not_found: true })
    }
    callback(null, result);
  });
};

module.exports.getOnCall = function (params, apiKey, callback) {
  internals.apiKey = apiKey;

  const oncallLevel = _.toLower(_.nth(params, 0));
  const searchStrArr = _.slice(params, 1, (params || []).length);
  const searchStr = _.trim(_.join(searchStrArr, ' '));

  if (internals.minLenValidation(searchStr)) {
    return callback(null, { min_len_err: true });
  }

  const searchKey = encodeURIComponent(searchStr);
  async.waterfall([
    function (wfCallback) {
      internals.getEscalationPolicies(searchKey, wfCallback);
    },
    function (escalationPolicies, wfCallback) {
      internals.getOnCallUsers(escalationPolicies, oncallLevel, wfCallback);
    },
    internals.getUserContacts,
  ], function (err, result) {
    if (err) {
      return callback(null, err);
    }

    callback(null, { oncall: result });
  });
};

module.exports.getUserFromName = function (params, apiKey, callback) {
  internals.apiKey = apiKey;

  const searchStrArr = _.slice(params, 0, (params || []).length);
  const searchStr = _.trim(_.join(searchStrArr, ' '));
  const stringCmp = _.toLower(_.join(searchStrArr, ''));

  if (internals.minLenValidation(searchStr)) {
    return callback(null, { min_len_err: true });
  }

  const searchKey = encodeURIComponent(searchStr);

  internals.queueCall(internals.searchUser(searchKey), function (err, userSearchResult) {
    if (err || _.get(userSearchResult, 'users', []).length === 0) {
      return callback(null, { user_not_found: true });
    }

    var searchResultWithLabel = _.values(
      internals.writeLabels(userSearchResult.users)).sort(function (item1, item2) {
        let firstMatchIndex = _.toLower(item1.name).indexOf(stringCmp);
        let secondMatchIndex = _.toLower(item2.name).indexOf(stringCmp);

        if (firstMatchIndex < secondMatchIndex) {
          return 1;
        } else if (firstMatchIndex > secondMatchIndex){
          return -1;
        };

        return 0;
      });

    var isTooManyResults = searchResultWithLabel.length > 3;

    if (isTooManyResults) {
      searchResultWithLabel = _.slice(searchResultWithLabel, 0, 3);
    }

    callback(null, { users: searchResultWithLabel, tooMany: isTooManyResults });
  });
};

internals.minLenValidation = function (searchStr) {
  if (_.isEmpty(searchStr) || (searchStr || '').length < 3) {
    return true;
  }
  return false;
};

internals.getEscalationPolicies = function (searchKey, callback) {
  internals.queueCall(internals.fetchEscalations(searchKey), function (err, escalationResult) {
    if (err) {
      return callback({ not_found: true });
    }

    const escalationResultLen = _.get(escalationResult, 'escalation_policies', []).length;
    if (escalationResultLen === 0) {
      return callback({ not_found: true });
    } else {
      return callback(null, _.take(escalationResult.escalation_policies, searchLimit));
    }
  });
};

internals.getOnCallUsers = function (escalationPolicies, onCallLevel, callback) {
  let onCallResult = {};

  async.map(escalationPolicies, function(item, asyncCallback) {
    onCallResult[item.id] = item;
    onCallResult[item.id].oncall = [];

    internals.queueCall(internals.fetchOnCall(item.id), asyncCallback);
  }, function(err, results) {
    if (err) {
      return callback({ not_found: true });
    }

    _.each(results, function (result) {
      const escalationId = _.get(result, 'oncalls.0.escalation_policy.id');
      let oncall;

      if (escalationId) {
        oncall = _.keyBy(_.sortBy(_.reduce(result.oncalls, function (result, item) {
          if (result[item.user.id]) {
            result[item.user.id].level = _.concat([_.get(item, 'escalation_level')], (result[item.user.id].level || [])).sort();

            return result;
          }

          item.user.level = _.concat((item.user.level || []), [_.get(item, 'escalation_level')]);
          if (onCallLevel === 'primary' && _.includes(item.user.level, 1)) {
            result[item.user.id] = item.user;
          } else if (onCallLevel === 'secondary' && _.includes(item.user.level, 2)) {
            result[item.user.id] = item.user;
          } else if (onCallLevel === 'all') {
            result[item.user.id] = item.user;
          }
          return result;
        }, {}), 'level', function (level) {
          return _.first(level);
        }), function (user) {
          return user.id;
        });

        onCallResult[escalationId].oncall = _.isEmpty(oncall) ? null : oncall;
      }
    });

    return callback(null, onCallResult);
  });
};

internals.getUserContacts = function (onCallResult, callback) {
  let userIds = _.uniq(_.flatten(_.map(_.values(onCallResult), function (item) {
    return _.keys(item.oncall);
  })));

  if (!userIds.length) {
    return callback({ no_users: true });
  }

  async.map(userIds, function(userId, asyncCallback) {
    internals.queueCall(internals.fetchUser([userId]), asyncCallback);
  }, function(err, results) {
    if (err) {
      return callback({ not_found: true });
    }

    let keyUserData = internals.writeLabels(_.keyBy(_.map(results, 'user'), function (user) {
      return user.id;
    }));

    _.each(keyUserData, function (value, key) {
      _.each(onCallResult, function (onCallItem) {
        if (onCallItem.oncall && onCallItem.oncall[key]) {
          value.level = onCallItem.oncall[key].level;
          onCallItem.oncall[key] = value;
        }
      });
    });

    return callback(null, _.values(onCallResult));
  });
};

internals.queueCall = function (requestOptions, callback) {
  requestQueue.push({
    task: {
      options: requestOptions,
      callback: callback
    }
  }, function (err) {
    console.log('queue processed');
  });
};

internals.callApi = function (config, queueCallback) {
  const req = http.request(config.task.options, function(response) {
    var responseStr = '';
    response.on('data', function(chunk) {
      responseStr += chunk;
    });
    response.on('end', function() {
      var responseObj = {};
      try {
        responseObj = JSON.parse(responseStr);
      } catch (err) {
        return queueCallback(err);
      }
      config.task.callback(null, responseObj);
      queueCallback();
    });
  });

  req.end();
};

internals.createRequestQueue = function (concurrentRate) {
  return async.queue(internals.callApi, concurrentRate);
};

internals.fetchTeams = function (teamSearchKeyword) {
  const options = {
    host: pagerdutyApi,
    path: '/teams?query=' + teamSearchKeyword,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchEscalations = function (escalationSearchKeyword) {
  const options = {
    host: pagerdutyApi,
    path: '/escalation_policies?include[]=services&include[]=teams&sort_by=name&query=' + escalationSearchKeyword,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchOnCall = function (escalationPolicyId) {
  const options = {
    host: pagerdutyApi,
    path: '/oncalls?time_zone=UTC&include[]=users&escalation_policy_ids[]='+ escalationPolicyId,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.fetchUser = function (params) {
  const userId = _.nth(params, 0);
  const options = {
    host: pagerdutyApi,
    path: '/users/'+ userId + '?include[]=contact_methods',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };
  return options;
};

internals.searchUser = function (searchString) {
  const options = {
    host: pagerdutyApi,
    path: '/users?query='+ searchString + '&include[]=contact_methods&include[]=notification_rules&include[]=teams',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Token token='+ internals.apiKey,
      'Accept': 'application/vnd.pagerduty+json;version=2'
    },
    rejectUnauthorized : false
  };

  return options;
};

internals.writeLabels = function (usersData) {
  return _.reduce(usersData, function (result, value, key) {
    value.contact_methods = _.map(value.contact_methods , function (contact) {
      if (contact.type === 'email_contact_method') {
        contact.email = true;
        contact.label = 'Email';
      } else if (contact.type === 'phone_contact_method') {
        contact.label = 'Phone';
      } else if (contact.type === 'sms_contact_method') {
        contact.label = 'Text';
      } else {
        contact = {};
      }
      return contact;
    });
    result[key] = value;
    return result;
  }, {});
};

requestQueue = internals.createRequestQueue(concurrentRate);
