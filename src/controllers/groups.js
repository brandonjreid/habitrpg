// @see ../routes for routing

function clone(a) {
   return JSON.parse(JSON.stringify(a));
}

var _ = require('lodash');
var nconf = require('nconf');
var async = require('async');
var shared = require('habitrpg-shared');
var User = require('./../models/user').model;
var Group = require('./../models/group').model;
var Challenge = require('./../models/challenge').model;
var api = module.exports;

/*
  ------------------------------------------------------------------------
  Groups
  ------------------------------------------------------------------------
*/

var partyFields = 'profile preferences stats achievements party backer contributor auth.timestamps items';
var nameFields = 'profile.name';
var challengeFields = '_id name';
var guildPopulate = {path: 'members', select: nameFields, options: {limit: 15} };
/**
 * For parties, we want a lot of member details so we can show their avatars in the header. For guilds, we want very
 * limited fields - and only a sampling of the members, beacuse they can be in the thousands
 * @param type: 'party' or otherwise
 * @param q: the Mongoose query we're building up
 */
var populateQuery = function(type, q){
  if (type == 'party')
    q.populate('members', partyFields);
  else
    q.populate(guildPopulate);
  q.populate('invites', nameFields);
  q.populate({
    path: 'challenges',
    match: (type=='habitrpg') ? {_id:{$ne:'95533e05-1ff9-4e46-970b-d77219f199e9'}} : undefined, // remove the Spread the Word Challenge for now, will revisit when we fix the closing-challenge bug
    select: challengeFields,
    options: {sort: {official: -1, timestamp: -1}}
  });
  return q;
}


api.getMember = function(req, res, next) {
  User.findById(req.params.uid).select(partyFields).exec(function(err, user){
    if (err) return next(err);
    if (!user) return res.json(400,{err:'User not found'});
    res.json(user);
  })
}

/**
 * Fetch groups list. This no longer returns party or tavern, as those can be requested indivdually
 * as /groups/party or /groups/tavern
 */
api.list = function(req, res, next) {
  var user = res.locals.user;
  var groupFields = 'name description memberCount balance leader';
  var sort = '-memberCount';
  var type = req.query.type || 'party,guilds,public,tavern';

  async.parallel({

    // unecessary given our ui-router setup
    party: function(cb){
      if (!~type.indexOf('party')) return cb(null, {});
      Group.findOne({type: 'party', members: {'$in': [user._id]}})
        .select(groupFields).exec(function(err, party){
          if (err) return cb(err);
          cb(null, (party === null ? [] : [party])); // return as an array for consistent ngResource use
        });
    },

    guilds: function(cb) {
      if (!~type.indexOf('guilds')) return cb(null, []);
      Group.find({members: {'$in': [user._id]}, type:'guild'})
        .select(groupFields).sort(sort).exec(cb);
    },

    'public': function(cb) {
      if (!~type.indexOf('public')) return cb(null, []);
      Group.find({privacy: 'public'})
        .select(groupFields + ' members')
        .sort(sort)
        .exec(function(err, groups){
          if (err) return cb(err);
          _.each(groups, function(g){
            // To save some client-side performance, don't send down the full members arr, just send down temp var _isMember
            if (~g.members.indexOf(user._id)) g._isMember = true;
            g.members = undefined;
          });
          cb(null, groups);
        });
    },

    // unecessary given our ui-router setup
    tavern: function(cb) {
      if (!~type.indexOf('tavern')) return cb(null, {});
      Group.findById('habitrpg').select(groupFields).exec(function(err, tavern){
        if (err) return cb(err);
        cb(null, [tavern]); // return as an array for consistent ngResource use
      });
    }

  }, function(err, results){
    if (err) return next(err);
    // ngResource expects everything as arrays. We used to send it down as a structured object: {public:[], party:{}, guilds:[], tavern:{}}
    // but unfortunately ngResource top-level attrs are considered the ngModels in the list, so we had to do weird stuff and multiple
    // requests to get it to work properly. Instead, we're not depending on the client to do filtering / organization, and we're
    // just sending down a merged array. Revisit
    var arr = _.reduce(results, function(m,v){
      if (_.isEmpty(v)) return m;
      return m.concat(_.isArray(v) ? v : [v]);
    }, [])
    res.json(arr);

    user = groupFields = sort = type = null;
  })
};

/**
 * Get group
 * TODO: implement requesting fields ?fields=chat,members
 */
api.get = function(req, res, next) {
  var user = res.locals.user;
  var gid = req.params.gid;

  var q = (gid == 'party')
    ? Group.findOne({type: 'party', members: {'$in': [user._id]}})
    : Group.findOne({$or:[
        {_id:gid, privacy:'public'},
        {_id:gid, privacy:'private', members: {$in:[user._id]}} // if the group is private, only return if they have access
      ]});
  populateQuery(gid, q);
  q.exec(function(err, group){
    if (err) return next(err);
    if (!group && gid!=='party') return res.json(404,{err: "Group not found or you don't have access."});
    res.json(group);
    gid = null;
  });
};


api.create = function(req, res, next) {
  var group = new Group(req.body);
  var user = res.locals.user;
  group.members = [user._id];
  group.leader = user._id;

  if(group.type === 'guild'){
    if(user.balance < 1) return res.json(401, {err: 'Not enough gems!'});

    group.balance = 1;
    user.balance--;

    async.waterfall([
      function(cb){user.save(cb)},
      function(saved,ct,cb){group.save(cb)},
      function(saved,ct,cb){saved.populate('members',nameFields,cb)}
    ],function(err,saved){
      if (err) return next(err);
      res.json(saved);
      group = user = null;
    });

  }else{
    async.waterfall([
      function(cb){
        Group.findOne({type:'party',members:{$in:[user._id]}},cb);
      },
      function(found, cb){
        if (found) return cb('Already in a party, try refreshing.');
        group.save(cb);
      },
      function(saved, count, cb){
        saved.populate('members', nameFields, cb);
      }
    ], function(err, populated){
      if (err == 'Already in a party, try refreshing.') return res.json(400,{err:err});
      if (err) return next(err);
      return res.json(populated);
      group = user = null;
    })
  }
}

api.update = function(req, res, next) {
  var group = res.locals.group;
  var user = res.locals.user;

  if(group.leader !== user._id)
    return res.json(401, {err: "Only the group leader can update the group!"});

  'name description logo logo leaderMessage leader'.split(' ').forEach(function(attr){
    group[attr] = req.body[attr];
  });

  group.save(function(err, saved){
    if (err) return next(err);
    res.send(204);
  });
}

api.attachGroup = function(req, res, next) {
  var gid = req.params.gid;
  var q = (gid == 'party') ? Group.findOne({type: 'party', members: {'$in': [res.locals.user._id]}}) : Group.findById(gid);
  q.exec(function(err, group){
    if(err) return next(err);
    if(!group) return res.json(404, {err: "Group not found"});
    res.locals.group = group;
    next();
  })
}

api.getChat = function(req, res, next) {
  return res.json(res.locals.group.chat);
}

/**
 * TODO make this it's own ngResource so we don't have to send down group data with each chat post
 */
api.postChat = function(req, res, next) {
  var user = res.locals.user
  var group = res.locals.group;
  if (group.type!='party' && user.flags.chatRevoked) return res.json(401,{err:'Your chat privileges have been revoked.'});
  var lastClientMsg = req.query.previousMsg;
  var chatUpdated = (lastClientMsg && group.chat && group.chat[0] && group.chat[0].id !== lastClientMsg) ? true : false;

  group.sendChat(req.query.message, user); // FIXME this should be body, but ngResource is funky

  if (group.type === 'party') {
    user.party.lastMessageSeen = group.chat[0].id;
    user.save();
  }

  group.save(function(err, saved){
    if (err) return next(err);
    return chatUpdated ? res.json({chat: group.chat}) : res.json({message: saved.chat[0]});
    group = chatUpdated = null;
  });
}

api.deleteChatMessage = function(req, res, next){
  var user = res.locals.user
  var group = res.locals.group;
  var message = _.find(group.chat, {id: req.params.messageId});

  if(!message) return res.json(404, {err: "Message not found!"});

  if(user._id !== message.uuid && !(user.backer && user.contributor.admin))
    return res.json(401, {err: "Not authorized to delete this message!"})

  var lastClientMsg = req.query.previousMsg;
  var chatUpdated = (lastClientMsg && group.chat && group.chat[0] && group.chat[0].id !== lastClientMsg) ? true : false;

  Group.update({_id:group._id}, {$pull:{chat:{id: req.params.messageId}}}, function(err){
    if(err) return next(err);
    chatUpdated ? res.json({chat: group.chat}) : res.send(204);
    group = chatUpdated = null;
  });
}

api.seenMessage = function(req,res,next){
  // Skip the auth step, we want this to be fast. If !found with uuid/token, then it just doesn't save
  // Check for req.params.gid to exist
  if(req.params.gid){
    var update = {$unset:{}};
    update['$unset']['newMessages.'+req.params.gid] = '';
    User.update({_id:req.headers['x-api-user'], apiToken:req.headers['x-api-key']},update).exec();
  }
  res.send(200);
}

api.likeChatMessage = function(req, res, next) {
  var user = res.locals.user;
  var group = res.locals.group;
  var message = _.find(group.chat, {id: req.params.mid});
  if (!message) return res.json(404, {err: "Message not found!"});
  if (message.uuid == user._id) return res.json(401, {err: "Can't like your own message. Don't be that person."});
  if (!message.likes) message.likes = {};
  if (message.likes[user._id]) {
    delete message.likes[user._id];
  } else {
    message.likes[user._id] = true;
  }
  group.markModified('chat');
  group.save(function(err,_saved){
    if (err) return next(err);
    return res.send(_saved.chat);
  })
}

api.join = function(req, res, next) {
  var user = res.locals.user,
    group = res.locals.group;

  if (group.type == 'party' && group._id == (user.invitations && user.invitations.party && user.invitations.party.id)) {
    user.invitations.party = undefined;
    user.save();
    // invite new user to pending quest
    if (group.quest.key && !group.quest.active) {
      group.quest.members[user._id] = undefined;
      group.markModified('quest.members');
    }
  }
  else if (group.type == 'guild' && user.invitations && user.invitations.guilds) {
    var i = _.findIndex(user.invitations.guilds, {id:group._id});
    if (~i) user.invitations.guilds.splice(i,1);
    user.save();
  }

  if (!_.contains(group.members, user._id)){
    group.members.push(user._id);
    group.invites.splice(_.indexOf(group.invites, user._id), 1);
  }

  async.series([
    function(cb){
      group.save(cb);
    },
    function(cb){
      populateQuery(group.type, Group.findById(group._id)).exec(cb);
    }
  ], function(err, results){
    if (err) return next(err);

    // Return the group? Or not?
    res.json(results[1]);
    group = null;
  });
}

api.leave = function(req, res, next) {
  var user = res.locals.user,
    group = res.locals.group;
  // When removing the user from challenges, should we keep the tasks?
  var keep = (/^remove-all/i).test(req.query.keep) ? 'remove-all' : 'keep-all';
  async.parallel([
    // Remove active quest from user if they're leaving the party
    function(cb){
      if (group.type != 'party') return cb(null,{},1);
      user.party.quest = Group.cleanQuestProgress();
      user.save(cb);
    },
    // Remove user from group challenges
    function(cb){
      async.waterfall([
        // Find relevant challenges
        function(cb2) {
          Challenge.find({
            _id: {$in: user.challenges}, // Challenges I am in
            group: group._id // that belong to the group I am leaving
          }, cb2);
        },
        // Update each challenge
        function(challenges, cb2) {
          Challenge.update(
            {_id:{$in: _.pluck(challenges, '_id')}},
            {$pull:{members:user._id}},
            {multi: true},
            function(err) {
             cb2(err, challenges); // pass `challenges` above to cb
            }
          );
        },
        // Unlink the challenge tasks from user
        function(challenges, cb2) {
          async.waterfall(challenges.map(function(chal) {
            return function(cb3) {
              var i = user.challenges.indexOf(chal._id)
              if (~i) user.challenges.splice(i,1);
              user.unlink({cid:chal._id, keep:keep}, cb3);
            }
          }), cb2);
        }
      ], cb);
    },
    // Update the group
    function(cb){
      var update = {$pull:{members:user._id}};
      if (group.type == 'party' && group.quest.key){
        update['$unset'] = {};
        update['$unset']['quest.members.' + user._id] = 1;
      }
      // FIXME do we want to remove the group `if group.members.length == 0` ? (well, 1 since the update hasn't gone through yet)
      if (group.members.length > 1) {
        var seniorMember = _.find(group.members, function (m) {return m != user._id});
        // If the leader is leaving (or if the leader previously left, and this wasn't accounted for)
        var leader = group.leader;
        if (leader == user._id || !~group.members.indexOf(leader)) {
          update['$set'] = update['$set'] || {};
          update['$set'].leader = seniorMember;
        }
        leader = group.quest && group.quest.leader;
        if (leader && (leader == user._id || !~group.members.indexOf(leader))) {
          update['$set'] = update['$set'] || {};
          update['$set']['quest.leader'] = seniorMember;
        }
      }
      update['$inc'] = {memberCount: -1};
      Group.update({_id:group._id},update,cb);
    }
  ],function(err){
    if (err) return next(err);
    return res.send(204);
    user = group = keep = null;
  })
}

api.invite = function(req, res, next) {
  var group = res.locals.group;
  var uuid = req.query.uuid;

  User.findById(uuid, function(err,invite){
    if (err) return next(err);
    if (!invite)
       return res.json(400,{err:'User with id "' + uuid + '" not found'});
    if (group.type == 'guild') {
      if (_.contains(group.members,uuid))
        return res.json(400,{err: "User already in that group"});
      if (invite.invitations && invite.invitations.guilds && _.find(invite.invitations.guilds, {id:group._id}))
        return res.json(400, {err:"User already invited to that group"});
      sendInvite();
    } else if (group.type == 'party') {
      if (invite.invitations && !_.isEmpty(invite.invitations.party))
        return res.json(400,{err:"User already pending invitation."});
      Group.find({type:'party', members:{$in:[uuid]}}, function(err, groups){
        if (err) return next(err);
        if (!_.isEmpty(groups))
          return res.json(400,{err:"User already in a party."})
        sendInvite();
      });
    }

    function sendInvite (){
      if(group.type === 'guild'){
        invite.invitations.guilds.push({id: group._id, name: group.name});
      }else{
        //req.body.type in 'guild', 'party'
        invite.invitations.party = {id: group._id, name: group.name}
      }

      group.invites.push(invite._id);

      async.series([
        function(cb){
          invite.save(cb);
        },
        function(cb){
          group.save(cb);
        },
        function(cb){
          populateQuery(group.type, Group.findById(group._id)).exec(cb);
        }
      ], function(err, results){
        if (err) return next(err);

        // Have to return whole group and its members for angular to show the invited user
        res.json(results[2]);
        group = uuid = null;
      });
    }
  });
}

api.removeMember = function(req, res, next){
  var group = res.locals.group;
  var uuid = req.query.uuid;
  var user = res.locals.user;

  if(group.leader !== user._id){
    return res.json(401, {err: "Only group leader can remove a member!"});
  }

  if(_.contains(group.members, uuid)){
    var update = {$pull:{members:uuid}};
    if(group.quest && group.quest.members){
      // remove member from quest
      update['$unset'] = {};
      update['$unset']['quest.members.' + uuid] = "";
      // TODO: run cleanQuestProgress and return scroll to member if member was quest owner
    }
    update['$inc'] = {memberCount: -1};
    Group.update({_id:group._id},update, function(err, saved){
      if (err) return next(err);

      // Sending an empty 204 because Group.update doesn't return the group
      // see http://mongoosejs.com/docs/api.html#model_Model.update
      return res.send(204);
    });
  }else if(_.contains(group.invites, uuid)){
    User.findById(uuid, function(err,invited){
      var invitations = invited.invitations;
      if(group.type === 'guild'){
        invitations.guilds.splice(_.indexOf(invitations.guilds, group._id), 1);
      }else{
        invitations.party = undefined;
      }

      async.series([
        function(cb){
          invited.save(cb);
        },
        function(cb){
          Group.update({_id:group._id},{$pull:{invites:uuid}}, cb);
        }
      ], function(err, results){
        if (err) return next(err);

        // Sending an empty 204 because Group.update doesn't return the group
        // see http://mongoosejs.com/docs/api.html#model_Model.update
        return res.send(204);
        group = uuid = null;
      });

    });
  }else{
    return res.json(400, {err: "User not found among group's members!"});
    group = uuid = null;
  }
}

// ------------------------------------
// Quests
// ------------------------------------

questStart = function(req, res, next) {
  var group = res.locals.group;
  var force = req.query.force;

//  if (group.quest.active) return res.json(400,{err:'Quest already began.'});
  // temporarily send error email, until we know more about this issue (then remove below, uncomment above).
  if (group.quest.active) return next('Quest already began.');

  group.markModified('quest');

  // Not ready yet, wait till everyone's accepted, rejected, or we force-start
  var statuses = _.values(group.quest.members);
  if (!force && (~statuses.indexOf(undefined) || ~statuses.indexOf(null))) {
    return group.save(function(err,saved){
      if (err) return next(err);
      res.json(saved);
    })
  }

  var parallel = [],
    questMembers = {},
    key = group.quest.key,
    quest = shared.content.quests[key],
    collected = quest.collect ? _.transform(quest.collect, function(m,v,k){m[k]=0}) : {};

  _.each(group.members, function(m){
    var updates = {$set:{},$inc:{'_v':1}};
    if (m == group.quest.leader)
      updates['$inc']['items.quests.'+key] = -1;
    if (group.quest.members[m] == true) {
      // See https://github.com/HabitRPG/habitrpg/issues/2168#issuecomment-31556322 , we need to *not* reset party.quest.progress.up
      //updates['$set']['party.quest'] = Group.cleanQuestProgress({key:key,progress:{collect:collected}});
      updates['$set']['party.quest.key'] = key;
      updates['$set']['party.quest.progress.down'] = 0;
      updates['$set']['party.quest.progress.collect'] = collected;
      updates['$set']['party.quest.completed'] = null;
      questMembers[m] = true;
    } else {
      updates['$set']['party.quest'] = Group.cleanQuestProgress();
    }
    parallel.push(function(cb2){
      User.update({_id:m},updates,cb2);
    });
  })

  group.quest.active = true;
  if (quest.boss)
    group.quest.progress.hp = quest.boss.hp;
  else
    group.quest.progress.collect = collected;
  group.quest.members = questMembers;
  group.markModified('quest'); // members & progress.collect are both Mixed types
  parallel.push(function(cb2){group.save(cb2)});

  parallel.push(function(cb){
    populateQuery(group.type, Group.findById(group._id)).exec(cb);
  });

  async.parallel(parallel,function(err, results){
    if (err) return next(err);

    var lastIndex = results.length -1;
    var groupClone = clone(group);

    groupClone.members = results[lastIndex].members;

    group = null;
    return res.json(groupClone);
  });
}

api.questAccept = function(req, res, next) {
  var group = res.locals.group;
  var user = res.locals.user;
  var key = req.query.key;

  if (!group) return res.json(400, {err: "Must be in a party to start quests."});

  // If ?key=xxx is provided, we're starting a new quest and inviting the party. Otherwise, we're a party member accepting the invitation
  if (key) {
    var quest = shared.content.quests[key];
    if (!quest) return res.json(404,{err:'Quest ' + key + ' not found'});
    if (quest.lvl && user.stats.lvl < quest.lvl) return res.json(400, {err: "You must be level "+quest.lvl+" to begin this quest."});
    if (group.quest.key) return res.json(400, {err: 'Party already on a quest (and only have one quest at a time)'});
    if (!user.items.quests[key]) return res.json(400, {err: "You don't own that quest scroll"});
    group.quest.key = key;
    group.quest.members = {};
    // Invite everyone. true means "accepted", false="rejected", undefined="pending". Once we click "start quest"
    // or everyone has either accepted/rejected, then we store quest key in user object.
    _.each(group.members, function(m){
      if (m == user._id) {
        group.quest.members[m] = true;
        group.quest.leader = user._id;
      } else
        group.quest.members[m] = undefined;
    });

  // Party member accepting the invitation
  } else {
    if (!group.quest.key) return res.json(400,{err:'No quest invitation has been sent out yet.'});
    group.quest.members[user._id] = true;
  }
  questStart(req,res,next);
}

api.questReject = function(req, res, next) {
  var group = res.locals.group;
  var user = res.locals.user;

  if (!group.quest.key) return res.json(400,{err:'No quest invitation has been sent out yet.'});
  group.quest.members[user._id] = false;
  questStart(req,res,next);
}

api.questCancel = function(req, res, next){
  // Cancel a quest BEFORE it has begun (i.e., in the invitation stage)
  // Quest scroll has not yet left quest owner's inventory so no need to return it.
  // Do not wipe quest progress for members because they'll want it to be applied to the next quest that's started.
  var group = res.locals.group;
  async.parallel([
    function(cb){
      if (! group.quest.active) {
        // Do not cancel active quests because this function does
        // not do the clean-up required for that.
        // TODO: return an informative error when quest is active
        group.quest = {key:null,progress:{},leader:null};
        group.markModified('quest');
        group.save(cb);
      }
    }
  ], function(err){
    if (err) return next(err);
    res.json(group);
    group = null;
  })
}

api.questAbort = function(req, res, next){
  // Abort a quest AFTER it has begun (see questCancel for BEFORE)
  var group = res.locals.group;
  async.parallel([
    function(cb){
      User.update(
        {_id:{$in: _.keys(group.quest.members)}},
        {
          $set: {'party.quest':Group.cleanQuestProgress()},
          $inc: {_v:1}
        },
        {multi:true},
        cb);
    },
    // Refund party leader quest scroll
    function(cb){
      if (group.quest.active) {
        var update = {$inc:{}};
        update['$inc']['items.quests.' + group.quest.key] = 1;
        User.update({_id:group.quest.leader}, update).exec();
      }
      group.quest = {key:null,progress:{},leader:null};
      group.markModified('quest');
      group.save(cb);
    }, function(cb){
      populateQuery(group.type, Group.findById(group._id)).exec(cb);
    }
  ], function(err, results){
    if (err) return next(err);

    var groupClone = clone(group);

    groupClone.members = results[2].members;

    res.json(groupClone);
    group = null;
  })
}
