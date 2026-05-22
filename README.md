# Iterable MCP Server

> **Note:** This is an unofficial, community-built MCP server. While Iterable has an official MCP server, our team ran into several issues with it, so we built this one tailored to our specific use cases.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the [Iterable API](https://api.iterable.com/api/docs). It lets AI assistants (Claude, Cursor, Devin, etc.) access your Iterable data — campaign analytics, subscriber lists, user profiles, templates, and more — through a standardized interface.

## Quick Start

### Prerequisites

- Node.js 18+
- An Iterable API key ([how to create one](https://support.iterable.com/hc/en-us/articles/360043464871-API-Keys))

### Running via npx

No installation required:

```bash
ITERABLE_API_KEY=your-api-key npx iterable-mcp
```

### Configuration with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "iterable": {
      "command": "npx",
      "args": ["-y", "iterable-mcp"],
      "env": {
        "ITERABLE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Configuration with Cursor

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "iterable": {
      "command": "npx",
      "args": ["-y", "iterable-mcp"],
      "env": {
        "ITERABLE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Configuration with VS Code (GitHub Copilot)

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "iterable": {
      "command": "npx",
      "args": ["-y", "iterable-mcp"],
      "env": {
        "ITERABLE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Configuration with Devin

In Devin's MCP settings, add a new server:

- **Name:** `iterable`
- **Command:** `npx -y iterable-mcp`
- **Environment Variables:**
  - `ITERABLE_API_KEY` → your API key

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ITERABLE_API_KEY` | Yes | Your Iterable server-side API key |

## Available Tools

### Campaigns

| Tool | Description |
|---|---|
| `list_campaigns` | List campaigns with pagination, sorting, and state filtering |
| `get_campaign` | Get detailed metadata for a specific campaign |
| `get_campaign_metrics` | Get performance metrics (opens, clicks, bounces, etc.) for one or more campaigns |

### Subscriber Lists

| Tool | Description |
|---|---|
| `get_lists` | List all subscriber lists |
| `get_list_size` | Get subscriber count for a specific list |
| `get_list_users` | Get email addresses subscribed to a list |

### Users

| Tool | Description |
|---|---|
| `get_user_by_email` | Look up a user profile by email address |

### Data Export

| Tool | Description |
|---|---|
| `export_data` | Export user data, subscribe events, or bounce events as CSV (parsed to JSON) |

### Templates

| Tool | Description |
|---|---|
| `get_templates` | List email templates with filtering by type |
| `get_template` | Get a specific email template by ID |

### Configuration

| Tool | Description |
|---|---|
| `get_message_types` | List all message types |
| `get_channels` | List all messaging channels |
| `get_metadata_tables` | List all metadata tables |
| `get_metadata_table` | Get all keys in a specific metadata table |

## Usage Tips

### Campaign Metrics

The `get_campaign_metrics` tool returns rich CSV data parsed into JSON. Key metrics include:

- `Total Email Sends` — emails sent
- `Unique Email Opens (filtered)` — bot-filtered unique opens (best for open rate)
- `Unique Email Clicks (filtered)` — bot-filtered unique clicks (best for CTR)
- `Total Unsubscribes` — unsubscribe count
- `Total Emails Bounced` — bounce count
- `Total Complaints` — spam complaints

You can pass multiple campaign IDs in a single request to get metrics for an entire week of campaigns at once.

### Rate Limits

- The export API (`export_data`) has aggressive rate limiting — space requests 10-15 seconds apart.
- Campaign metrics are less aggressive but still space requests 2-3 seconds apart when fetching in bulk.

### Open Rate & CTR Formulas

- **Open Rate** = `Unique Email Opens (filtered)` / `Total Email Sends`
- **Click-Through Rate** = `Unique Email Clicks (filtered)` / `Total Email Sends`

## Development

```bash
git clone https://github.com/jginorio/iterable-mcp.git
cd iterable-mcp
npm install
npm run build
```

To test locally:

```bash
ITERABLE_API_KEY=your-key node dist/index.js
```

## License

MIT
