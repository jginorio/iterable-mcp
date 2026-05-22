#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ITERABLE_API_BASE = "https://api.iterable.com/api";

function getApiKey(): string {
  const apiKey = process.env.ITERABLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ITERABLE_API_KEY environment variable is required. " +
        "Set it to your Iterable API key."
    );
  }
  return apiKey;
}

async function iterableRequest(
  path: string,
  options?: { method?: string; body?: Record<string, unknown> }
): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${ITERABLE_API_BASE}${path}`;
  const method = options?.method ?? "GET";

  const headers: Record<string, string> = {
    "Api-Key": apiKey,
    Accept: "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };

  if (options?.body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Iterable API error (${response.status}): ${errorText}`
    );
  }

  return response;
}

async function iterableJson(
  path: string,
  options?: { method?: string; body?: Record<string, unknown> }
): Promise<unknown> {
  const response = await iterableRequest(path, options);
  return response.json();
}

async function iterableText(path: string): Promise<string> {
  const response = await iterableRequest(path);
  return response.text();
}

function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

const server = new McpServer({
  name: "Iterable MCP",
  version: "1.0.0",
});

// ─── Campaign Tools ─────────────────────────────────────────────────────────

server.tool(
  "list_campaigns",
  "List campaigns in your Iterable project. Supports pagination, sorting, and filtering by state. " +
    "Returns campaign metadata including name, state, sendSize, dates, and template info.",
  {
    page: z
      .number()
      .optional()
      .describe("Page number (starting at 1). Defaults to 1."),
    page_size: z
      .number()
      .optional()
      .describe("Results per page (max 1000, default 20)."),
    sort: z
      .string()
      .optional()
      .describe(
        "Sort field with optional direction prefix. Use - for descending, + for ascending. " +
          "Sortable fields: id, name, createdAt, updatedAt, startAt. Examples: '-createdAt', '+name', 'id'."
      ),
    campaign_state: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by state(s). Valid: 'Draft', 'Ready', 'Scheduled', 'Running', 'Finished', " +
          "'Starting', 'Aborted', 'Recurring', 'Archived'."
      ),
  },
  async ({ page, page_size, sort, campaign_state }) => {
    const params = new URLSearchParams();
    if (page) params.append("page", page.toString());
    if (page_size) params.append("pageSize", page_size.toString());
    if (sort) params.append("sort", sort);
    if (campaign_state) {
      for (const state of campaign_state) {
        params.append("campaignState", state);
      }
    }

    const query = params.toString();
    const path = `/campaigns${query ? `?${query}` : ""}`;
    const data = await iterableJson(path);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_campaign",
  "Get detailed metadata for a specific campaign by ID. " +
    "Returns name, sendSize, listIds, templateId, campaignState, startAt, endedAt, and more.",
  {
    campaign_id: z.number().describe("The campaign ID to retrieve."),
  },
  async ({ campaign_id }) => {
    const data = await iterableJson(`/campaigns/${campaign_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_campaign_metrics",
  "Get performance metrics for one or more campaigns. Returns CSV data parsed into JSON. " +
    "Key metrics include: Total Email Sends, Total/Unique Email Opens, " +
    "Unique Email Opens (filtered), Unique Email Clicks (filtered), " +
    "Total Unsubscribes, Total Emails Bounced, Total Complaints. " +
    "You can pass multiple campaign IDs in a single request.",
  {
    campaign_ids: z
      .array(z.number())
      .describe("Array of campaign IDs to get metrics for."),
  },
  async ({ campaign_ids }) => {
    const params = new URLSearchParams();
    for (const id of campaign_ids) {
      params.append("campaignId", id.toString());
    }

    const csv = await iterableText(`/campaigns/metrics?${params.toString()}`);
    const parsed = parseCsv(csv);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { raw_csv: csv, parsed: parsed },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_campaign_link_performance",
  "Get per-URL click performance for a campaign. Exports individual click events and aggregates them " +
    "by URL to produce a ranked list of most-clicked links. Returns total clicks and unique clicks per URL. " +
    "This is the programmatic equivalent of the 'Link Performance' tab in the Iterable UI. " +
    "Rate limited — the export API has aggressive rate limiting, space requests 10-15 seconds apart. " +
    "For campaigns with many clicks, this may return a large amount of data.",
  {
    campaign_id: z.number().describe("The campaign ID to get link performance for."),
    start_date: z
      .string()
      .describe(
        "Start datetime in ISO 8601 format (e.g. '2026-05-22T00:00:00'). " +
          "Should cover the campaign's send date."
      ),
    end_date: z
      .string()
      .describe(
        "End datetime in ISO 8601 format (e.g. '2026-05-23T00:00:00'). " +
          "Should be at least 1-2 days after the campaign send date to capture delayed clicks."
      ),
    exclude_bots: z
      .boolean()
      .optional()
      .describe("Exclude bot clicks from the results. Defaults to true."),
  },
  async ({ campaign_id, start_date, end_date, exclude_bots }) => {
    const shouldExcludeBots = exclude_bots !== false;

    const params = new URLSearchParams();
    params.append("dataTypeName", "emailClick");
    params.append("startDateTime", `${start_date}.000Z`);
    params.append("endDateTime", `${end_date}.000Z`);
    params.append("campaignId", campaign_id.toString());

    const response = await iterableRequest(
      `/export/data.json?${params.toString()}`
    );
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);

    const urlStats = new Map<
      string,
      { total_clicks: number; unique_emails: Set<string> }
    >();

    for (const line of lines) {
      const event = JSON.parse(line) as {
        url?: string;
        email?: string;
        isBot?: boolean;
        "trackedLink.templateUrl"?: string;
      };

      if (shouldExcludeBots && event.isBot) continue;

      const templateUrl =
        event["trackedLink.templateUrl"] ?? event.url ?? "unknown";
      // Strip UTM params to group by base URL
      let baseUrl: string;
      try {
        const parsed = new URL(templateUrl);
        parsed.searchParams.delete("utm_source");
        parsed.searchParams.delete("utm_medium");
        parsed.searchParams.delete("utm_campaign");
        baseUrl = parsed.toString();
      } catch {
        baseUrl = templateUrl;
      }

      const existing = urlStats.get(baseUrl);
      if (existing) {
        existing.total_clicks++;
        if (event.email) existing.unique_emails.add(event.email);
      } else {
        const emails = new Set<string>();
        if (event.email) emails.add(event.email);
        urlStats.set(baseUrl, { total_clicks: 1, unique_emails: emails });
      }
    }

    const ranked = Array.from(urlStats.entries())
      .map(([url, stats]) => ({
        url,
        total_clicks: stats.total_clicks,
        unique_clicks: stats.unique_emails.size,
      }))
      .sort((a, b) => b.total_clicks - a.total_clicks);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              total_click_events: lines.length,
              bots_excluded: shouldExcludeBots,
              unique_urls: ranked.length,
              links: ranked,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── List Tools ─────────────────────────────────────────────────────────────

server.tool(
  "get_lists",
  "List all subscriber lists in your Iterable project. " +
    "Returns list IDs, names, types, and creation dates.",
  {},
  async () => {
    const data = await iterableJson("/lists");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_list_size",
  "Get the current subscriber count for a specific list. Returns a plain integer.",
  {
    list_id: z.number().describe("The list ID to get the size of."),
  },
  async ({ list_id }) => {
    const size = await iterableText(`/lists/${list_id}/size`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { list_id, subscriber_count: parseInt(size.trim(), 10) },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_list_users",
  "Get all email addresses subscribed to a specific list. " +
    "Returns plain text with one email per line. " +
    "Warning: large lists may return a lot of data.",
  {
    list_id: z.number().describe("The list ID to get subscribers for."),
  },
  async ({ list_id }) => {
    const text = await iterableText(`/lists/getUsers?listId=${list_id}`);
    const emails = text.trim().split("\n").filter(Boolean);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { list_id, count: emails.length, emails: emails.slice(0, 100), truncated: emails.length > 100 },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── User Tools ─────────────────────────────────────────────────────────────

server.tool(
  "get_user_by_email",
  "Look up a user profile by email address. " +
    "Returns user data fields, subscription status, and metadata.",
  {
    email: z.string().describe("The email address to look up."),
  },
  async ({ email }) => {
    const data = await iterableJson(
      `/users/getByEmail?email=${encodeURIComponent(email)}`
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Export Tools ───────────────────────────────────────────────────────────

server.tool(
  "export_data",
  "Export data from Iterable as CSV (parsed into JSON). " +
    "Supports exporting users, email subscribe events, email bounce events, and more. " +
    "Rate limited — space requests 10-15 seconds apart. " +
    "Date format must be ISO 8601 with URL-encoded colons (handled automatically).",
  {
    data_type: z
      .string()
      .describe(
        "The type of data to export. Valid types: 'user', 'emailSubscribe', 'emailBounce'. " +
          "Note: 'emailUnSubscribe' may return 401 depending on API key permissions."
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        "Start datetime in ISO 8601 format (e.g. '2026-03-23T00:00:00'). " +
          "Required if range is not specified."
      ),
    end_date: z
      .string()
      .optional()
      .describe(
        "End datetime in ISO 8601 format (e.g. '2026-03-30T00:00:00'). " +
          "Required if range is not specified."
      ),
    range: z
      .string()
      .optional()
      .describe(
        "Predefined range instead of start/end dates. Valid values: 'Today', 'All'."
      ),
  },
  async ({ data_type, start_date, end_date, range }) => {
    const params = new URLSearchParams();
    params.append("dataTypeName", data_type);

    if (range) {
      params.append("range", range);
    } else if (start_date && end_date) {
      params.append("startDateTime", `${start_date}.000Z`);
      params.append("endDateTime", `${end_date}.000Z`);
    }

    const csv = await iterableText(`/export/data.csv?${params.toString()}`);
    const parsed = parseCsv(csv);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { data_type, record_count: parsed.length, data: parsed.slice(0, 50), truncated: parsed.length > 50 },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ─── Message Types Tool ─────────────────────────────────────────────────────

server.tool(
  "get_message_types",
  "List all message types configured in your Iterable project. " +
    "Returns channel types, names, and subscription policies.",
  {},
  async () => {
    const data = await iterableJson("/messageTypes");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Template Tools ─────────────────────────────────────────────────────────

server.tool(
  "get_templates",
  "List email templates in your Iterable project. Supports pagination and filtering.",
  {
    template_type: z
      .string()
      .optional()
      .describe(
        "Filter by template type. Valid values: 'Base', 'Blast', 'Triggered', 'Workflow'."
      ),
    page: z
      .number()
      .optional()
      .describe("Page number (starting at 1)."),
    page_size: z
      .number()
      .optional()
      .describe("Results per page."),
  },
  async ({ template_type, page, page_size }) => {
    const params = new URLSearchParams();
    params.append("messageMedium", "Email");
    if (template_type) params.append("templateType", template_type);
    if (page) params.append("page", page.toString());
    if (page_size) params.append("pageSize", page_size.toString());

    const data = await iterableJson(`/templates?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_template",
  "Get a specific email template by ID. Returns template content, metadata, and settings.",
  {
    template_id: z.number().describe("The template ID to retrieve."),
  },
  async ({ template_id }) => {
    const data = await iterableJson(`/templates/email/get?templateId=${template_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Channel Tools ──────────────────────────────────────────────────────────

server.tool(
  "get_channels",
  "List all messaging channels configured in your Iterable project.",
  {},
  async () => {
    const data = await iterableJson("/channels");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Metadata Tools ─────────────────────────────────────────────────────────

server.tool(
  "get_metadata_tables",
  "List all metadata tables in your Iterable project. " +
    "Metadata tables store custom key-value data accessible in templates and campaigns.",
  {},
  async () => {
    const data = await iterableJson("/metadata");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_metadata_table",
  "Get all keys in a specific metadata table.",
  {
    table_name: z.string().describe("The name of the metadata table."),
  },
  async ({ table_name }) => {
    const data = await iterableJson(`/metadata/${encodeURIComponent(table_name)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Iterable MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
