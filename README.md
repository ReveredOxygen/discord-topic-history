# Topic History Bot

## Running

Edit config.toml to have your bot's token and change settings as needed, then run `node bot.js`  
In order to function, the bot needs `Manage Messages` and `Send Messages` permissions. Thanks to Discord's permissions being broken, it can see all channel topics regardless of whether it has perms to see those channels.
See [here](https://www.writebots.com/discord-bot-token/) for getting your bot's token

## Using the bot

Run `!topics` (or other configured command) to get a list of previous topics for that channel. It accepts up to one channel as an argument, defaulting to the current channel.  
Reacting to the bot's message with :notepad_spiral: will cause it to upload a JSON export of the channel topics to paste.gg and set a link as the embed's URL.
