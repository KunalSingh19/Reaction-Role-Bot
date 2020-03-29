/*******************************************************************************
 * This file is part of ReactionRoleBot, a role-assigning Discord bot.
 * Copyright (C) 2020 Mimickal (Mia Moretti).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 ******************************************************************************/
const fs = require('fs');

const Discord = require('discord.js');

const cache = require('./cache');
const database = require('./database');

// Everything operates on IDs, so we can safely rely on partials.
// This causes reaction events to fire for uncached messages.
const client = new Discord.Client({
	partials: [
		Discord.Constants.PartialTypes.MESSAGE,
		Discord.Constants.PartialTypes.CHANNEL,
		Discord.Constants.PartialTypes.REACTION
	]
});
const token_file = process.argv[2] || '/etc/discord/ReactionRoleBot/token';
const token = fs.readFileSync(token_file).toString().trim();

// Map of command names to handling functions. Doubles as a validator.
const COMMANDS = new Map();
COMMANDS.set('select', selectMessage);
COMMANDS.set('role-add', setupReactRole);
COMMANDS.set('role-remove', removeReactRole);
COMMANDS.set('info', sayInfo);


const Events = Discord.Constants.Events;
client.on(Events.CLIENT_READY, () => console.log(`Logged in as ${client.user.tag}`));
client.on(Events.GUILD_CREATE, onGuildJoin);
client.on(Events.GUILD_DELETE, onGuildLeave);
client.on(Events.MESSAGE_CREATE, onMessage);
client.on(Events.MESSAGE_REACTION_ADD, onReactionAdd);
client.on(Events.MESSAGE_REACTION_REMOVE, onReactionRemove);


client.login(token).catch(err => {
	logError(err);
	process.exit(1);
});

/**
 * Event handler for when the bot joins a new guild.
 */
function onGuildJoin(guild) {
	guild.members.fetch(client.user.id)
		.then(clientMember => {
			const Perms = Discord.Permissions.FLAGS;

			// This bot probably shouldn't be given the admin permission, but if
			// we have it then the other ones don't matter.
			if (clientMember.hasPermission(Perms.ADMINISTRATOR)) {
				return;
			}

			// Permissions integer: 1074078784
			const requiredPermMap = {
				[Perms.ADD_REACTIONS]: 'Add Reactions',
				[Perms.MANAGE_MESSAGES]: 'Manage Messages',
				[Perms.MANAGE_ROLES]: 'Manage Roles',
				[Perms.READ_MESSAGE_HISTORY]: 'Read Message History',
				[Perms.USE_EXTERNAL_EMOJIS]: 'Use External Emojis',
				[Perms.VIEW_CHANNEL]: 'Read Text Channels & See Voice Channels'
			};

			let missingPermNames = Object.entries(requiredPermMap)
				.filter(([perm, name]) => clientMember.hasPermission(parseInt(perm)))
				.map(([perm, name]) => name);

			if (missingPermNames) {
				return guild.owner.createDM()
					.then(dmChannel => dmChannel.send(
						"Heads up, I am missing the following permissions. " +
						"Without them, I probably won't work right:\n" +
						missingPermNames.join('\n')
					));
			}
		})
		.catch(logError);
}

/**
 * Event handler for when the bot leaves (or is kicked from) a guild.
 */
function onGuildLeave(guild) {
	database.clearGuildInfo(guild.id)
		.catch(logError);
}

/**
 * Event handler for getting a new message.
 * Parses and delegates any role bot command.
 */
function onMessage(msg) {
	// Ignore anything where we're not even mentioned
	if (!msg.mentions.has(client.user)) {
		return;
	}

	let msgParts = msg.content.split(/\s+/);

	// Only pay attention to messages where we're mentioned first.
	let mentionUserId = extractId(msgParts.shift());
	if (mentionUserId !== client.user.id) {
		return;
	}

	let cmdName = msgParts.shift();

	// Only pay attention to messages that are known commands.
	if (!COMMANDS.has(cmdName)) {
		logError('Possible unrecognized command: ' + msg.content);
		return;
	}

	if (
		!msg.member.hasPermission(Discord.Permissions.FLAGS.ADMINISTRATOR)
		&& cmdName !== 'info' // FIXME You know why this is bad.
	) {
		msg.reply("You don't have permission to use that command");
		return;
	}

	// Run the handler for this command
	COMMANDS.get(cmdName)(msg, msgParts);
}

/**
 * Selects a message to associate with any subsequent role commands.
 * Previously selected message is cleared if the user gives bad input for this.
 */
function selectMessage(msg, parts) {
	const usage = '\nUsage: `select <channel> <message_id>`';

	let maybeChannelId = parts.shift();
	let maybeMessageId = parts.shift();

	let channelId = extractId(maybeChannelId);
	let messageId = extractId(maybeMessageId);

	let issue;
	if      (parts.length > 0) issue = 'Too many arguments!';
	else if (!maybeChannelId)  issue = 'Missing channel_id!';
	else if (!maybeMessageId)  issue = 'Missing message_id!';
	else if (!channelId) issue = `Invalid channel_id \`${maybeChannelId}\`!`;
	else if (!messageId) issue = `Invalid message_id \`${maybeMessageId}\`!`;

	if (issue) {
		msg.reply(issue + usage);
		cache.clearSelectedMessage(msg.author.id);
		return;
	}

	client.channels.fetch(channelId)
		.then(channel => channel.messages.fetch(messageId))
		.then(message => {
			cache.selectMessage(msg.author.id, message);

			return msg.reply(
				`selected message with ID \`${message.id}\` ` +
				`in channel <#${channelId}>. Link: ${message.url}`
			);
		})
		.catch(err => {
			// The user is trying to select a new message, so at least clear
			// their old selection. Principle of least surprise, and all that...
			cache.clearSelectedMessage(msg.author.id);

			let errMsg;
			if (err.message === 'Unknown Channel') {
				errMsg = "I can't find a channel in this server with ID "
					+ `\`${channelId}\`.`;
			}
			else if (err.message === 'Unknown Message') {
				errMsg = `I can't find a message with ID \`${messageId}\` `
					+ `in channel <#${channelId}>.`;
			}
			else {
				errMsg = `I got an error I don't recognize:\n\`${err.message}\``;
				logError(err, 'For message', msg.content);
			}

			errMsg += usage;

			msg.reply(errMsg);
		});
}

/**
 * Associate an emoji reaction with a role for the currently selected message.
 */
function setupReactRole(msg, parts) {
	const usage = '\nUsage: `role-add <emoji> <role>`';

	let rawEmoji = parts.shift(); // Needed to print emoji in command response
	let maybeRole  = parts.shift();

	let emoji    = extractEmoji(rawEmoji);
	// TODO need to validate this role actually exists
	let roleId = extractId(maybeRole);

	let issue;
	if (parts.length > 0) issue = 'Too many arguments!';
	else if (!emoji)      issue = 'Missing emoji!';
	else if (!maybeRole)  issue = 'Missing role!';
	else if (!roleId) issue = `Invalid role \`${maybeRole}\`!`;

	if (issue) {
		msg.reply(issue + usage);
		return;
	}

	let userId = msg.author.id;

	cache.addEmojiRole(userId, emoji, roleId)
		.then(() => cache.getSelectedMessage(userId))
		.then(selectedMessage => selectedMessage.react(emoji))
		.then(reaction => msg.reply(
			`mapped ${rawEmoji} to <@&${roleId}> on message \`${reaction.message.id}\``
		))
		.catch(err => {
			if (err.message === 'No message selected!') {
				msg.reply('You need to select a message first!');
			}
			else if (err.message === 'Unknown Emoji') {
				msg.reply(`I can't find an emoji with ID \`${emoji}\`` + usage);
			}
			else if (err.message === 'Missing Permissions') {
				msg.reply("I don't have permission to react to the selected message");
			}
			else {
				msg.reply(`I got an error I don't recognize:\n\`${err.message}\``);
				logError(err, 'For message', msg.content);
			}
		});
}

/**
 * Removes an emoji reaction role association from the currently selected
 * message.
 */
function removeReactRole(msg, parts) {
	const usage = '\nUsage: `role-remove <emoji>`';

	let rawEmoji = parts.shift();
	let emoji    = extractEmoji(rawEmoji);

	let issue;
	if (parts.length > 0) issue = 'Too many arguments!';
	else if (!emoji)      issue = 'Missing emoji!';

	if (issue) {
		msg.reply(issue + usage);
		return;
	}

	let userId = msg.author.id;

	Promise.resolve() // Hack to pass error from getSelectedMessage to .catch
		.then(() => cache.getSelectedMessage(userId))
		.then(selectedMessage => {
			let emojiReacts = selectedMessage.reactions.cache.get(emoji);

			if (!emojiReacts) {
				throw new Error('No reaction for emoji');
			}

			return emojiReacts.remove()
				.then(() => cache.removeEmojiRole(userId, emoji))
				.then(() => msg.reply(
					`removed ${rawEmoji} role from message \`${selectedMessage.id}\``
				));
		})
		.catch(err => {
			if (err.message === 'No message selected!') {
				msg.reply('You need to select a message first!');
			}
			else if (err.message === 'No reaction for emoji') {
				msg.reply(
					`Selected message does not have ${rawEmoji} reaction.\n` +
					'If that displayed as a raw ID instead of an emoji, you ' +
					'might be using the wrong ID.'
				);
			}
			else if (err.message === 'Missing Permissions') {
				msg.reply("I don't have permission to modify the selected message");
			}
			else {
				msg.reply(`I got an error I don't recognize:\n\`${err.message}\``);
				logError(err, 'For message', msg.content);
			}
		});
}

/**
 * Replies with info about this bot, including a link to the source code to be
 * compliant with the AGPLv3 this bot is licensed under.
 */
function sayInfo(msg) {
	const info = require('./package.json');
	msg.reply(
		`${info.description}\n` +
		`**Running version:** ${info.version}\n` +
		`**Source code:** ${info.homepage}`
	);
}

/**
 * Event handler for when a reaction is added to a message.
 * Checks if the message has any reaction roles configured, assigning a role to
 * the user who added the reaction, if applicable. Ignores reacts added by this
 * bot, of course.
 */
function onReactionAdd(reaction, user) {
	if (user === client.user) {
		return;
	}

	let emoji = emojiIdFromEmoji(reaction.emoji);

	cache.getReactRole(reaction.message.id, emoji)
		.then(roleId => {
			if (!roleId) {
				return;
			}

			// TODO ensure reaction.message is a TextChannel and not a DM or something.
			//      Need to do this so we can access guild on the message
			return reaction.message.guild.members.fetch(user.id)
				.then(member => member.roles.add(roleId, 'Role bot assignment'))
				.then(() => console.log(`added role ${roleId} to ${user}`));
		})
		.catch(logError);
}

/**
 * Event handler for when a reaction is removed from a message.
 * Checks if the message has any reaction roles configured, removing a role from
 * the user who removed their reaction, if applicable. Ignored reacts removed by
 * this bot, of course.
 */
function onReactionRemove(reaction, user) {
	if (user === client.user) {
		return;
	}

	let emoji = emojiIdFromEmoji(reaction.emoji);

	cache.getReactRole(reaction.message.id, emoji)
		.then(roleId => {
			if (!roleId) {
				return;
			}

			// TODO same as onReactionAdd, ensure this is a TextChannel
			return reaction.message.guild.members.fetch(user.id)
				.then(member => member.roles.remove(roleId, 'Role bot removal'))
				.then(() => console.log(`removed role ${roleId} from ${user}`))
		})
		.catch(logError);
}

// I'm aware Discord.MessageMentions.*_PATTERN constants exist, but they all
// have the global flag set, which screws up matching groups. For this reason we
// need to construct our own.
//
// Also, for flexibility's sake we just don't care about what type of ID this
// is. This could have collisions but it's unlikely.
function extractId(str) {
	if (!str) {
		return null;
	}

	let match = str.match(/(\d{17,19})/);
	return match ? match[1] : null;
}

/**
 * Allows us to handle custom server emojis. They are encoded in messages like
 * this: <:flagtg:681985787864416286>. Discord.js can add emojis using a
 * unicode string for built-in emojis, or the ID portion of the name
 * (e.g. 681985787864416286) for custom server emojis.
 */
function extractEmoji(emoji) {
	let match = emoji.match(/<:.+:(\d{17,19})>/);
	return match ? match[1] : emoji;
}

/**
 * Built-in emojis are identified by name. Custom emojis are identified by ID.
 * This function handles that nuance for us.
 */
function emojiIdFromEmoji(emoji) {
	return emoji.id || emoji.name;
}

function logError(err) {
	// Single function to make error redirection easier in the future.
	// TODO handle when we don't have permission to add roles or reactions
	console.error(err);
}

// vvv  MICHELLES STUFF  vvv

async function cmdAddRoleToggle(message, args) {
	if (args.length !== 3) {
		message.channel.send(
`Command mark-message was invoked with ${args.length} arguments while it should have exactly 3.
\`add-role-toggle <message_id> <emoji> <role_id>\``)
		return;
	}

	let target_msg_id = args.shift();
	let emoji_name    = emojiIdFromStr(args.shift());
	let role_id       = args.shift();

	message.channel.messages.fetch(target_msg_id)
		.then(async target_msg => {
			console.log(emoji_name);
			await target_msg.react(emoji_name);
		}).catch(async err => {
			if (err instanceof Discord.DiscordAPIError &&
				err.message === 'Missing Access') {

				logIssue(
					`No permission to read ${channel.id} (#${channel.name})`
				);
				return;
			} else if (err instanceof Discord.DiscordAPIError) {
				await message.channel.send(`Error: ${err.message}.`);
				return;
			}
		}
	);

}

async function onAddReaction(reaction) {
	if (reaction.me) {
		return;
	}
	console.log(emojiIdFromEmoji(reaction.emoji), reaction.user_id);
}

async function onRemoveReaction(reaction) {
	if (reaction.me) {
		return;
	}
	console.log(emojiIdFromEmoji(reaction.emoji), reaction.user_id);
}

