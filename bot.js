#!/usr/bin/env node

const toml = require('toml')
const fs = require('fs')
const sqlite = require('sqlite3').verbose()
const Discord = require('discord.js')
const Pagination = require('discord-paginationembed')
const PasteGG = require('paste.gg').PasteGG
const https = require('https')

const config = toml.parse(fs.readFileSync('config.toml'))

const db = new sqlite.Database(config.db.path)

db.run(`
CREATE TABLE IF NOT EXISTS topics(
    channel_id    TEXT       NOT NULL,
    text          TEXT       NOT NULL,
    first_seen    TIMESTAMP  NOT NULL  DEFAULT CURRENT_TIMESTAMP,
    unset         TIMESTAMP    -- The time this stopped being the channel topic, if known
)
`, (err) => {
    if (err !== null) { throw err }

    db.run(`
    CREATE INDEX IF NOT EXISTS timestamp
    ON topics(first_seen)
    `)
    db.run(`
    CREATE INDEX IF NOT EXISTS channel
    ON topics(channel_id)
    `)

    const newStatement = db.prepare(`
    INSERT INTO topics(channel_id, text)
    VALUES ($channel, $text)
    `)

    const changeStatement = db.prepare(`
    UPDATE topics
    SET unset = CURRENT_TIMESTAMP
    WHERE rowid IN (
        SELECT rowid
        FROM topics
        WHERE channel_id = $channel
        ORDER BY first_seen DESC
        LIMIT 1
    )
    `)

    const getTopicsStatement = db.prepare(`
    SELECT * FROM topics
    WHERE channel_id = $channel
    ORDER BY first_seen DESC
    `)

    const client = new Discord.Client()

    function updateTopic(channel) {
        if (config.bot.ignored_channels.includes(channel.id)) { return }
        if (!['text', 'news'].includes(channel.type)) { return }

        getTopicsStatement.get({ $channel: channel.id }, (err, row) => {
            getTopicsStatement.reset()

            if (err !== null) { throw err }

            topic = channel.topic === null ? '' : channel.topic
            if (row === undefined || row.text !== topic) {
                newStatement.run({
                    $channel: channel.id,
                    $text: topic
                })
            }
        })
    }

    function iso8601(fromDb) {
        iso = ''
        iso += fromDb.slice(0, 10)
        iso += 'T'
        iso += fromDb.slice(11, 19)
        iso += 'Z'

        return iso
    }

    function generateJson(rows) {
        output = []

        rows.forEach(row => {
            output.push({
                text: row.text,
                first_seen: iso8601(row.first_seen),
                unset: row.unset === null ? undefined : iso8601(row.unset)
            })
        })

        return output
    }

    function generateJsonWithMeta(rows, channel) {
        return {
            updated: new Date().toISOString(),
            channel_id: channel.id,
            channel_name: channel.name,
            guild_id: channel.guild.id,
            guild_name: channel.guild.name,
            topics: generateJson(rows)
        }
    }

    function generateEmbeds(rows) {
        // https://stackoverflow.com/a/37826698/9096513
        const chunkedRows = rows.reduce((resultArray, item, index) => {
            const chunkIndex = Math.floor(index / config.bot.topics_per_page)

            if (!resultArray[chunkIndex]) {
                resultArray[chunkIndex] = [] // start a new chunk
            }

            resultArray[chunkIndex].push(item)

            return resultArray
        }, [])

        const embeds = []
        const pages = chunkedRows.length
        let page = 1

        chunkedRows.forEach((chunk) => {
            embed = new Discord.MessageEmbed()
            embed.setFooter(`Page ${page} of ${pages}`)

            chunk.forEach((row) => {
                const text = row.text == '' ? '*No topic*' : row.text
                embed.addField(row.first_seen + ' UTC', text, true)
            })

            embeds.push(embed)

            page++
        })

        return embeds
    }

    function pasteUrl(responseStr) {
        res = JSON.parse(responseStr)
        id = res.result.id

        return `https://${config.bot.paste_url}/p/anonymous/${id}`
    }

    function sendTopics(requestMessage, channel) {
        if (channel instanceof Discord.GuildChannel) {
            const perms = channel.permissionsFor(requestMessage.author)
            const hasPerms = perms.has(Discord.Permissions.FLAGS.VIEW_CHANNEL)

            if (!hasPerms) {
                requestMessage.channel.send('You do not have permission to view that channel')
                return
            }
        }

        getTopicsStatement.all({ $channel: channel.id }, (err, rows) => {
            if (err !== null) { throw err }

            embeds = generateEmbeds(rows)

            if (embeds.length === 0) {
                requestMessage.channel.send('No topic history for ' + channel.toString())
                return
            }

            embed = new Pagination.Embeds()
                .setArray(embeds)
                .setAuthorizedUsers(requestMessage.author.id)
                .setChannel(requestMessage.channel)
                .setTimeout(config.bot.navigation_timeout)
                .setTitle('Topic history for #' + channel.name)
                .addFunctionEmoji('🗒️', (_, instance) => {
                    data = JSON.stringify({
                        name: 'Topic history for #' + channel.name,
                        // timeout: 'PT5M',
                        files: [{
                            name: 'topics.min.json',
                            content: {
                                format: 'text',
                                value: JSON.stringify(generateJsonWithMeta(rows, channel)),
                                highlight_language: 'json'
                            }
                        },
                        {
                            name: 'topics.json',
                            content: {
                                format: 'text',
                                value: JSON.stringify(generateJsonWithMeta(rows, channel), null, 2),
                                highlight_language: 'json'
                            }
                        }
                        ]
                    })
                    options = {
                        hostname: 'api.' + config.bot.paste_url,
                        port: 443,
                        path: '/v1/pastes',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': data.length
                        }
                    }

                    const req = https.request(options, res => {
                        res.on('data', d => {
                            const url = pasteUrl(d.toString())
                            instance.setURL(url)
                            // Build to force it to update in Discord
                            instance.build()
                        })
                    })
                    req.write(data)
                    req.end()
                })
                .build()
        })
    }

    const channelRegex = /^<#(\d+)>$/
    function topicCommand(message) {
        args = message.content.slice(config.bot.command.length).trim()

        if (args === '') {
            sendTopics(message, message.channel)
        } else {
            let match = args.match(channelRegex)

            if (match) {
                channel = client.channels.fetch(match[1])
                    .then((channel) => {
                        sendTopics(message, channel)
                    })
                    .catch((err) => {
                        if (err instanceof Discord.DiscordAPIError) {
                            message.channel.send('No such channel found.')
                        }
                    })
            } else {
                message.channel.send('Invalid channel provided. Make sure you link to the channel.')
            }
        }
    }

    client.on('ready', () => {
        console.log(`Logged in as ${client.user.tag}!`);


        console.log('Finished checking topics on startup')
    });

    client.on('channelUpdate', (oldChannel, newChannel) => {
        if (oldChannel.topic === newChannel.topic) { return }

        changeStatement.run({ $channel: oldChannel.id })

        updateTopic(newChannel)
    })

    client.on('channelCreate', (channel) => {
        updateTopic(channel)
    })

    client.on('guildCreate', guild => {
        guild.channels.cache.forEach((channel) => {
            updateTopic(channel)
        })
    })

    client.on('message', (message) => {
        if (!message.content.startsWith(config.bot.command)) { return }

        topicCommand(message)
    })

    client.login(config.bot.token)
})