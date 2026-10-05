# Party Organizer

A Discord bot that posts a team board. Members join a party by clicking an emoji, then pick a role. The server owner can also place people on the board directly.

A **team** is one board. A team holds up to 20 **parties**, and each party holds up to 5 members. Someone can be in one party per team. Joining a second party on the same board moves them. They can still be on other teams at the same time.

## What you need

- [Node.js](https://nodejs.org/) 18 or newer
- A Discord application with a bot token
- A Firebase project with Cloud Firestore and a service account key

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot** and add a bot. Copy the token. This is `DISCORD_TOKEN`.
3. Copy the Application ID from **General Information**. This is `DISCORD_CLIENT_ID`.
4. Turn on **Message Content Intent** only if you add features that read message text. This bot does not need it.
5. Under **Installation**, set the install link to **Discord Provided Link**. For Guild Install, enable the scopes `bot` and `applications.commands`.
6. Give the bot these permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Add Reactions
   - Manage Messages

   That set is permission integer `93248`.

7. Invite the bot to your server with that install link.

`Manage Messages` lets the bot take down a member’s old party emoji when they move or when the owner changes the roster.

## 2. Create Firestore

1. In the [Firebase console](https://console.firebase.google.com/), create a project and enable **Cloud Firestore**.
2. Open **Project settings → Service accounts → Generate new private key**.
3. Save the JSON file outside this repo. Do not commit it.

Team data is stored in the `guilds` collection, one document per Discord server.

## 3. Configure the project

```bash
npm install
copy .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead of `copy`.

Fill in `.env`:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_SERVICE_ACCOUNT=C:\path\to\service-account.json
```

`DISCORD_GUILD_ID` is the server where you test. With it set, slash commands show up right after deploy. Leave it empty to register the commands for every server the bot is in. Global commands can take up to an hour to appear.

To copy a server ID, turn on Discord **Settings → Advanced → Developer Mode**, then right-click the server icon and choose **Copy Server ID**.

## 4. Start the bot

Register the slash commands, then start the bot:

```bash
npm run deploy
npm run dev
```

The terminal prints `Logged in as YourBot#1234` when the bot is online. Leave that process running.

Run `npm run deploy` again after command options change. Restart `npm run dev` after code changes. Stop the old process before starting a second one, or Discord will disconnect the first login.

For a production build:

```bash
npm run build
npm start
```

## Using a team

Someone with **Manage Server** creates a board. The server owner can create one too, because the owner has that permission.

```text
/team name:Sunday Raid party-count:4
```

`name` is the title on the board. `party-count` is how many parties to create, from 1 to 20. Each new `/team` posts another board and leaves older boards up.

The bot posts an image of the parties and adds one emoji per party. Parties 1–10 use the number emojis. Parties 11–20 use the letter emojis A through J.

### Join, move, and leave

1. Click a party’s emoji on the board. Your name appears in the next open slot.
2. Click **DPS**, **Tank**, **Healer**, or **Support** under the board. You can change that choice later. Each person has one role on that team.
3. Click a different party emoji to move. Your role stays with you.
4. Press **Leave**, or remove your emoji, to leave. Your role is cleared.

A party with 5 members rejects another join. You can be in a different party on a different team.

## Owner commands

Only the server owner can change someone else’s place. The reply is visible only to the owner, and the board image updates for everyone.

| Command | What it does |
| --- | --- |
| `/member add` | Put a member into a party |
| `/member remove` | Take a member off that team |
| `/member switch` | Move a member to another party on the same team |

Each command asks for the **user** and the **team**. Add and switch also ask for the **party**. Start typing and pick the team and party from the list. If two teams share a name, the list numbers them.

Moving someone keeps their role. Removing them clears it. A full party stays full. Someone placed by the owner can press **Leave** on that board. The Leave button shows up on a board the next time it updates.

`/ping` replies with `Pong!` and is there to check that the bot is responding.

## Who can do what

| Action | Who |
| --- | --- |
| Create a team with `/team` | Manage Server |
| Join, move, leave, and pick a role | Anyone who can see the channel and add reactions |
| Add, remove, or move another member | Server owner |

The bot also needs the channel permissions from step 1. A channel overwrite can still block it even after the invite.

## Deploy on Cloudflare

Party joins use Discord’s gateway, and the board image uses a native canvas library. Those need a long-running process, so the bot runs as one [Cloudflare Container](https://developers.cloudflare.com/containers/). A Worker starts that container and pings it every 5 minutes so it stays connected.

You need Docker, a Cloudflare account, and Wrangler logged in:

```bash
npx wrangler login
```

Stop the local `npm run dev` process first. Discord allows one connection per bot token.

Store the secrets in Cloudflare. Do not put them in the image or in git.

```bash
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put FIREBASE_PROJECT_ID
Get-Content -Raw C:\path\to\service-account.json | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
```

On macOS or Linux, pipe the key with `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON < service-account.json`.

Then build and publish:

```bash
npm run cf:deploy
```

The container uses a 1 GiB instance. Open the Worker URL to wake it. `/health` returns `ok` when the process is listening. `npm run cf:tail` shows logs.

Slash commands are still registered from your machine with `npm run deploy`. The container only runs the bot.

If the board image runs the process out of memory, change `instance_type` in `wrangler.jsonc` from `basic` to `standard-1` and deploy again.

## Troubleshooting

- **The slash command is missing a new option.** Run `npm run deploy`, then close the command menu and open it again.
- **`/member` does nothing or the bot says the command was not found.** Restart `npm run dev` after pulling new code, then run `npm run deploy`.
- **The board posts, but the emojis are missing.** Allow **Add Reactions** in that channel.
- **The owner moved someone, but their old emoji stayed.** Allow **Manage Messages** in that channel.
- **Commands take a long time to appear.** Set `DISCORD_GUILD_ID` and deploy again so they register to that server immediately.
