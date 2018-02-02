const Discord = require('discord.js');
const Icy = require('icy');
const client = new Discord.Client();
const WebSocket = require('ws');
const express = require('express');
const listen_port = process.env.API_PORT || 3000;
const fs = require('fs');
const bodyParser = require('body-parser');

const SECRET_TOKEN = process.env.SECRET_TOKEN;

var stop_requested = false;
var current_playing_url = "";
var current_stream = null;
var flag_continue = true;
var flag_stop_if_error = false;

var playlist_idx = -1;
var playlist = [];

function save_state()
{
  var state = {
    playlist_idx: playlist_idx,
    playlist: playlist,
    flag_continue: flag_continue,
    flag_stop_if_error: flag_stop_if_error,
    playing: current_stream !== null
  }
  fs.writeFile("config", JSON.stringify(state), function(err) {
      if (err) {
          return console.log(err);
      }
      console.log("Config saved!");
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
    on_failure(chan_id);
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
    console.log(e);
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

function start(c, connection, icy_type, logging_channel, url)
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

      current_stream = connection.playStream(res, function(err, str) {
        send(logging_channel, "[STRIMERROR]", err); 
        send(logging_channel, "[STRIM]", str);
      } );
      setup_events(current_stream, c, connection, icy_type, logging_channel, url);

    });
  }
  else
  {
    current_stream = connection.playArbitraryInput(url);
    save_state()
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
  start(c, connection, false, logging_channel, item.url);

  client.user.setGame(item.name + " - " + item.artist).then(

    (successMessage) => {

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
    save_state()
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

function start_html_server(c, connection, logging_channel) {
  const app = express();

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
      new_playlist.push({url: song.url, name: song.name, artist: song.artist_name});
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

client.on('message', message => {
  //console.log("[MSG]", message.author, message.content);
  if (message.content === 'ruby restart' && message.author.id == "122908555178147840")
  {
    message.reply('Okie~ be right back!');
    client.destroy();
    setTimeout(() => {
      process.exit();
    }, 1000);
    
  }
});



client.login(process.env.BOT_TOKEN);
