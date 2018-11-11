const Discord = require('discord.js');
const Icy = require('icy');
const client = new Discord.Client();
const WebSocket = require('ws');
const express = require('express');
const listen_port = process.env.API_PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');
const ytdl = require('ytdl-core');
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const { URL } = require('url');
const proto = {
  'http:': require('http'),
  'https:': require('https')
}
const fileType = require('file-type');
var jsmediatags = require("jsmediatags");

const SECRET_TOKEN = process.env.SECRET_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const HAS_NEXTCLOUD_DB = process.env.NEXTCLOUD_DB_HOST !== undefined;
const NEXTCLOUD_DB_HOST = process.env.NEXTCLOUD_DB_HOST;
const NEXTCLOUD_DB_PORT = process.env.NEXTCLOUD_DB_PORT || 5432;
const HOME_URL = process.env.HOME_URL;

const MAX_SONG_LIST_DISPLAY_LENGTH = 8

var stop_requested = false;
var current_playing_url = "";
var current_stream = null;
var flag_continue = true;
var flag_stop_if_error = false;
var last_restart_time = 0;

var playlist_idx = -1;
var playlist = [];

var blacklist = {};
var command_hash = {};

function shuffle(a) {
    var j, x, i;
    for (i = a.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = a[i];
        a[i] = a[j];
        a[j] = x;
    }
}

function save_state(on_complete)
{
  var state = {
    playlist_idx: playlist_idx,
    playlist: playlist,
    flag_continue: flag_continue,
    flag_stop_if_error: flag_stop_if_error,
    playing: current_stream !== null,
    blacklist: blacklist,
    last_restart_time: last_restart_time
  }
  fs.writeFile("config", JSON.stringify(state), function(err) {
      if (err) {
          return console.log(err);
      }
      console.log("Config saved!");
      if (on_complete)
      {
        on_complete();        
      }
  }); 
}

function load_state(on_playing)
{
  fs.readFile('config', function(err, data) {
    if (err) {
      return console.log(err);
    }
    try
    {
      var state = JSON.parse(data);
      playlist_idx = state.playlist_idx
      playlist = state.playlist
      flag_continue = state.flag_continue
      flag_stop_if_error = state.flag_stop_if_error
      blacklist = state.blacklist || {}
      last_restart_time = state.last_restart_time || 0
      if (state.playing && on_playing)
      {
        on_playing();
      }
      console.log("Config loaded!");
    }
    catch (e)
    {
      return console.log(e);
    }
  });
}

function send(channel)
{
  try
  {
    var message = "[" + new Date() + "]";
    for (var idx in arguments)
    {
      if (idx == 0) { continue; }
      message += " "
      message += arguments[idx]
    }
    channel.send(message);
  }
  catch (e)
  {
    console.log("[SEND]", e)
  }
}

function find_channel(client, chan_id, on_success, on_failure)
{
  var channels = [];

  client.guilds.map( (g) => {
    g.channels.
      filter( (c) => { return chan_id.indexOf(c.id) != -1; } ).
      map ( (c) => { channels.push(c) } );
  });

  if (channels.length == 1)
  {
    on_success(channels[0]);
  }
  else
  {
    setTimeout( function(){ find_channel(client, chan_id, on_success, on_failure); }, 10);
  }
}

function not_find_chan(chan)
{
  console.log("could not find channel", chan_id)
}

function setup_events(current_stream, c, connection, icy_type, logging_channel, url)
{
  current_stream.on("start", function() {
    send(logging_channel, "[SETUP]", "started", c.id, "url:", current_playing_url)
  });

  current_stream.on("error", function(e) {
    send(logging_channel, "[SETUP]", "errored!");
    send(logging_channel, "[SETUP]", e);
    if (!stop_requested)
    {
      if (current_stream.totalStreamTime > 5000 && !flag_stop_if_error)
      {
        send(logging_channel, "[SETUP]", "Stream lasted for more than 5 seconds and stop_if_error not set, restarting.");
        setTimeout(()=>{play_music(c, connection, logging_channel);}, 500); 
      }
    }
    current_stream.end();
    stop_requested = false
  });

  current_stream.on("end", function(e) {
    send(logging_channel, "[SETUP]", "ended!", c.id, "url:", current_playing_url);
    if (!stop_requested)
    {
      if (flag_continue)
      {
        send(logging_channel, "[SETUP]", "Continue flag set, restarting.");
        stop_music(logging_channel);
        setTimeout(()=>{play_music(c, connection, logging_channel);}, 500); 
      }
    }
    stop_requested = false
  });

  current_playing_url = url;
}

function start(c, connection, icy_type, logging_channel, url, type)
{
  if (icy_type)
  {
    Icy.get(url, function (res) {

      // log the HTTP response headers
      send(logging_channel, "[START]", res.headers);

      // log any "metadata" events that happen
      res.on('metadata', function (metadata) {
        var parsed = Icy.parse(metadata);
        send(logging_channel, "```\n", parsed, "\n```");
      });

      current_stream = connection.play(res, function(err, str) {
        send(logging_channel, "[STRIMERROR]", err); 
        send(logging_channel, "[STRIM]", str);
      } );
      setup_events(current_stream, c, connection, icy_type, logging_channel, url);

    });
  }
  else
  {
    if (type === "YOUTUBE")
    {
      const streamOptions = { seek: 0, volume: 1 };
      const stream = ytdl(url, { filter : 'audioonly' });
      current_stream = connection.play(stream, streamOptions);
    }
    else
    {
      current_stream = connection.play(url);
    }
    save_state();
    setup_events(current_stream, c, connection, icy_type, logging_channel, url);
  }
}

function play_music(c, connection, logging_channel)
{
  if (current_stream)
  {
    send(logging_channel, "[ERROR]", "Already Playing"); 
    return;
  }
  if (playlist.length == 0)
  {
    send(logging_channel, "[ERROR]", "Playlist empty");
    return;
  }

  playlist_idx = (playlist_idx + 1) % playlist.length
  var item = playlist[playlist_idx]
  start(c, connection, false, logging_channel, item.url, item.type);

  client.user.setActivity(item.name + " - " + item.artist, {
    type: "LISTENING",
    url: "https://astrobunny.net"
  }).then(

    (successMessage) => {
      console.log("Successfully set message")

  }).catch(

    (reason) => {
      console.log('Handle rejected promise ('+reason+') here.');

  });
}

function stop_music(logging_channel)
{
  if (current_stream)
  {
    stop_requested = true;
    current_stream.end();
    current_stream = null;
    save_state();
  }
}

function get_status_json() {
  var status = {
    status: "stopped",
    url: current_playing_url,
    stop_if_error: flag_stop_if_error,
    continue: flag_continue,
    playlist_idx: playlist_idx
  }

  if (current_stream)
  {
    status.status = "started"
  }
  return JSON.stringify(status);

}

var LOG_CHAN = null;

function start_html_server(c, connection, logging_channel) {
  const app = express();

  LOG_CHAN = logging_channel;

  app.all('/public/*', (req, res) => {
    var reply = "<pre>\n";

    for(var i=0;i<playlist.length;i++)
    {
      var idx = (i + playlist_idx) % playlist.length;
      reply += (i+1) + ". " + playlist[idx].name + " - " + playlist[idx].artist + "\n";
    }

    reply += "</pre>";
    res.send(reply)
  });  

  app.use(function (req, res, next) {
    if (req.query.token === SECRET_TOKEN)
    {
        next();
        return;
    }
    res.status(404).send("not found")
  });

  app.use(bodyParser.text({ type: 'application/json' }));

  app.get('/', (req, res) => {
    res.send(get_status_json())
  });

  app.get('/playlist', (req, res) => {
    res.send(JSON.stringify({playlist: playlist}))
  });

  app.get('/playlist/add', (req, res) => {
    if (!req.query.url)
    {
      res.send(JSON.stringify({playlist: playlist, error: "no url"}))
      return;
    }
    playlist.push({url: req.query.url, name: req.query.name, artist: req.query.artist})
    save_state()
    res.send(JSON.stringify({playlist: playlist}))
  });

  app.put('/playlist', (req, res) => {
    var body = JSON.parse(req.body)
    var new_playlist = [];
    for (var key in body.playlist)
    {
      var song = body.playlist[key];
      if (!song.url || !song.name || !song.artist_name)
      {
        res.status(400).send("invalid") 
        return;
      }
      new_playlist.push({url: song.url, name: song.name, artist: song.artist_name, type: "FILE"});
    }
    playlist = new_playlist;
    save_state();
    res.send(JSON.stringify({playlist: playlist}))
  });

  app.get('/playlist/clear', (req, res) => {
    playlist = []
    save_state()
    res.send(JSON.stringify({playlist: playlist}))
  })

  app.get('/playlist/set', (req, res) => {
    if (req.query.next)
    {
      playlist_idx = parseInt(req.query.next) - 1
      if (playlist_idx < -1 || playlist_idx > playlist.length)
      {
        playlist_idx = -1
      }
    }
    if (req.query.continue)
    {
      flag_continue = req.query.continue === 'true'
    }
    if (req.query.stop_if_error)
    {
      flag_stop_if_error = req.query.stop_if_error === 'true'
    }
    save_state()
    res.send(JSON.stringify({playlist: playlist}))
  })

  app.get('/play', (req, res) => {
    send(logging_channel, "[START]", "Start requested");
    play_music(c, connection, logging_channel)
    res.send(get_status_json());
  });

  app.get('/stop', (req, res) => {
    send(logging_channel, "[STOP]", "Stop requested");
    playlist_idx = -1;
    stop_music(logging_channel)
    res.send(get_status_json());
  });

  app.listen(listen_port, () => {
    console.log('API listening on port', listen_port);
    load_state(function(){
      send(logging_channel, "[START]", "Restart from previous running state");
      play_music(c, connection, logging_channel)
    })
  })


  function register_user_command(command, func)
  {
    command_hash[command] = func;
  }

  register_user_command("help", (message, m) => {
    var reply = "these are the commands available:\n```\n";
    reply += "help    - displays this message\n";
    reply += "queue   - displays the current playlist\n";
    reply += "np      - states the current playing song\n";
    reply += "next    - skips to the next song\n";
    reply += "clear   - clears the playlist and stops playback\n";
    reply += "add     - add a song. Type 'help add' to find out more!\n";
    reply += "delet   - remove a song. Type 'help delet' to find out more!\n";
    reply += "restart - restart the bot. usually fixes all problems\n";
    reply += "```\n";

    if (message === "add")
    {
      reply = "How to use add:\n```";
      reply += "USAGE: @" + client.user.username + " add <url of youtube link or mp3>\n";
      reply += "\n";
      reply += "Example:\n";
      reply += "@" + client.user.username + " add https://www.youtube.com/watch?v=L0rA_AKMtBc\n";
      reply += "```\n";
    }

    if (message === "delet")
    {
      reply = "How to use delet:\n```";
      reply += "USAGE: @" + client.user.username + " delet <number to delete>\n";
      reply += "\n";
      reply += "The number is the number seen when you use @" + client.user.username + " queue\n";
      reply += "\n";
      reply += "Example:\n";
      reply += "@" + client.user.username + " delet 1\n";
      reply += "```\n";
    }
    m.reply(reply);
  });

  register_user_command("queue", (message, m) => {
    var reply = "Current queue is on repeat:\n```"
    for(var i=0;i<Math.min(playlist.length, MAX_SONG_LIST_DISPLAY_LENGTH);i++)
    {
      var idx = (i + playlist_idx) % playlist.length;
      reply += (i+1) + ". " + playlist[idx].name + " - " + playlist[idx].artist + "\n";
    }
    if (playlist.length > MAX_SONG_LIST_DISPLAY_LENGTH)
    {
      var num = playlist.length - MAX_SONG_LIST_DISPLAY_LENGTH;
      reply += "and " + num + " more song"+(num === 1 ? "": "s")+"...\n"
    }
    reply += "```"
    if (playlist.length > MAX_SONG_LIST_DISPLAY_LENGTH)
    {
      reply += "see " + HOME_URL + "/public/playlist"
    }
    m.reply(reply);
  })

  register_user_command("np", (message, m) => {
    var reply = "I am now playing: `" + playlist[playlist_idx].name + " - " + playlist[playlist_idx].artist + "`";
    m.reply(reply);
  });

  register_user_command("next", (message, m) => {
    var reply = "Moving to next song.";
    stop_music(logging_channel)
    setTimeout(function(){
      play_music(c, connection, logging_channel);
    }, 2000);
    m.reply(reply);
  });

  register_user_command("clear", (message, m) => {

    var reply = "Cleared playlist.";
    playlist = [];
    stop_music(logging_channel);
    m.reply(reply);
  });

  register_user_command("delet", (message, m) => {

    if (message.length === 0)
    {
      m.reply("please type `help delet` to find out how to use this command.");
      return;
    }

    var idx = ((parseInt(message) - 1) + playlist_idx) % playlist.length;
    if (idx < 0 || idx >= playlist.length)
    {
      m.reply("invalid number, please type `help delet` to find out how to use this command.");
      return;
    }
    var thing = playlist[idx];
    playlist.splice(idx, 1);
    m.reply("removed " + thing.name);
  });

  register_user_command("restart", (message, m) => {
    var now = (new Date).getTime();
    if (now - last_restart_time < 1000 * 60 * 5)
    {
      m.reply('Okie~ be right back!');
      client.destroy();
      last_restart_time = now;
      save_state();
      setTimeout(() => {
        process.exit();
      }, 5000);
    }
    else
    {
      m.reply('Please wait 5 minutes before restarting again.');
    }
  });

  register_user_command("add", (message, m) => {

    var extra_tokens = message.split(";").filter(Boolean);

    var custom = {}

    for (var idx=1; idx < extra_tokens.length; idx++)
    {
      var toks = extra_tokens[idx].split("=", 2);
      custom[toks[0]] = toks[1];
    }

    message = extra_tokens[0]

    console.log(custom);

    function url_exists(url, callback)
    {
        var xhr = new XMLHttpRequest();
        xhr.open('HEAD', url);
        xhr.onreadystatechange = function() {
            if (this.readyState == this.DONE) {
              callback(this.status == 200);
            }
        };
        xhr.send();
    }

    if (message.length === 0)
    {
      m.reply("please type `help add` to find out how to use this command.");
      return;
    }

    url_exists(message, function(isgood)
    {
      if (isgood)
      {
        const stream = ytdl.getInfo(message, function(err, info)
        {

          function complete()
          {          
            if (!current_stream)
            {
              play_music(c, connection, logging_channel);
            }
            else
            {
              save_state();
            }
          }

          if (err)
          {
            // normal file?
            const url = new URL(message);
            proto[url.protocol].get(url, res => {
              res.once('data', chunk => {
                var type = fileType(chunk);

                if (type.mime === "video/mp4")
                {
                  var p = url.pathname.split("/");
                  var name = p[p.length-1];
                  var songmeta = {
                    url: message,
                    name: custom.name || name,
                    artist: custom.artist || "File",
                    type: "FILE"
                  };
                  playlist.push(songmeta);
                  m.reply("added: " + songmeta.name + " - " + songmeta.artist);
                  complete();
                }
                else if (type.mime.indexOf("audio") === 0)
                {
                  new jsmediatags.Reader(message)
                    .setTagsToRead(["title", "artist"])
                    .read({
                      onSuccess: function(tag) {
                        var name = (tag.tags.title || custom.name) || "Unknown title";
                        var artist = (tag.tags.artist || custom.artist) || "Unknown artist";
                        playlist.push({
                          url: message,
                          name: name,
                          artist: artist,
                          type: "FILE"
                        });
                        m.reply("added: " + name + " - " + artist);
                        complete();
                      },
                      onError: function(error) {
                        send(logging_channel, "[ERROR]", message, "[MSG]", error)
                        m.reply("error reading " + message);
                      }
                    });
                }
                else
                {
                  m.reply("Unknown file type: " + type.mime);
                }

                res.destroy();
                console.log();
              });
            });
          }
          else
          {
            // youtube vid
            playlist.push({
              url: message,
              name: info.title,
              artist: "Youtube",
              type: "YOUTUBE"
            })

            m.reply("Youtube file `" + info.title + "` added!");
            complete();
          }


        });

        //
      }
      else
      {
        m.reply("`" + message + "` is not a valid URL");
      }
    });

  });

}

client.on('ready', () => {

  find_channel(client, "331596661954576385", (logging_channel) => {
    send(logging_channel, "Started up")

    find_channel(client, process.env.CHANNEL_ID, (c)=> {
      c.join()
       .then((connection) => { 
        start_html_server(c, connection, logging_channel);
        //play_radio(); 
      })
       .catch(console.error);
    }, not_find_chan);

  }, not_find_chan);

});

function handle_admin_message(message, m)
{
  if (message === 'restart')
  {
    m.reply('Okie~ be right back!');
    client.destroy();
    save_state();
    setTimeout(() => {
      process.exit();
    }, 1000);
  }
}

function handle_user_message(message, m)
{
  if (LOG_CHAN)
  {
    send(LOG_CHAN, "[MSG]", "from: <@" + m.author.id + ">", message);
  }

  const command = message.split(" ").filter(Boolean)[0];
  if (command_hash[command])
  {
    command_hash[command](message.replace(command+" ", ""), m);
  }
}


client.on('message', message => {

  //console.log("[MSG]", message.author, message.content);
  const id_front = '<@'+CLIENT_ID+'> ';
  if (message.content.indexOf(id_front) == 0)
  {
    if (message.author.id == "122908555178147840")
    {
      handle_admin_message(message.content.replace(id_front, ""), message);
    }

    if (blacklist[message.author.id] === undefined || blacklist[message.author.id] === false)
    {
      handle_user_message(message.content.replace(id_front, ""), message);
    } 
  }
});


client.login(process.env.BOT_TOKEN);
