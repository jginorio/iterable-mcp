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

/**
 * Normalizes Iterable's `transactionalData`, which may arrive either as a JSON
 * string or as an already-parsed object depending on the export. Returns the
 * parsed object, or undefined if it's absent or can't be interpreted.
 */
function parseTransactionalData(
  value: string | Record<string, unknown> | undefined | null
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
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
    let processedCount = 0;

    for (const line of lines) {
      const event = JSON.parse(line) as {
        url?: string;
        email?: string;
        isBot?: boolean;
        "trackedLink.templateUrl"?: string;
      };

      if (shouldExcludeBots && event.isBot) continue;
      processedCount++;

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
              total_click_events: processedCount,
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

server.tool(
  "get_campaign_openers",
  "Get which contacts opened a campaign, matched to Asana task IDs via messageId join. " +
    "Step 1: fetches emailSend events to build a messageId → asana_task_id + email map (from transactionalData). " +
    "Step 2: fetches emailOpen events and joins on messageId to determine who opened. " +
    "Returns per-contact open status with asana_task_id, email, business_name, and open details. " +
    "Falls back to email-only matching if transactionalData is not present. " +
    "Rate limited — space requests 10-15 seconds apart.",
  {
    campaign_id: z.number().describe("The campaign ID to get openers for."),
    start_date: z
      .string()
      .describe(
        "Start datetime in ISO 8601 format (e.g. '2026-05-01T00:00:00'). " +
          "Should be on or before the campaign send date."
      ),
    end_date: z
      .string()
      .describe(
        "End datetime in ISO 8601 format (e.g. '2026-06-30T00:00:00'). " +
          "Should be after the campaign send date to capture delayed opens."
      ),
    exclude_bots: z
      .boolean()
      .optional()
      .describe("Exclude bot opens from the results. Defaults to true."),
  },
  async ({ campaign_id, start_date, end_date, exclude_bots }) => {
    const shouldExcludeBots = exclude_bots !== false;
    const commonParams = `&startDateTime=${start_date}.000Z&endDateTime=${end_date}.000Z&campaignId=${campaign_id}`;

    // Step 1: fetch emailSend events → build messageId → contact map
    const sendResponse = await iterableRequest(
      `/export/data.json?dataTypeName=emailSend${commonParams}`
    );
    const sendText = await sendResponse.text();
    const sendLines = sendText.trim().split("\n").filter(Boolean);

    type ContactInfo = {
      email: string;
      asana_task_id?: string;
      business_name?: string;
      client_name?: string;
    };

    const messageToContact = new Map<string, ContactInfo>();
    // Secondary index so opens can still be joined to a sent contact by email
    // when their messageId is missing or doesn't match a send event. This keeps
    // the join key (asana_task_id ?? email) consistent between Step 2 and Step 3.
    const emailToContact = new Map<string, ContactInfo>();

    // Derives the canonical join key for a contact, used by both the opener
    // map (Step 2) and the per-contact results (Step 3) so they always agree.
    const contactKey = (c: ContactInfo) => c.asana_task_id ?? c.email;

    for (const line of sendLines) {
      const event = JSON.parse(line) as {
        email?: string;
        messageId?: string;
        // Iterable may serialize this as a JSON string or return it already
        // parsed as an object, depending on the export, so accept both.
        transactionalData?: string | Record<string, unknown>;
      };
      if (!event.messageId || !event.email) continue;

      const contact: ContactInfo = { email: event.email.toLowerCase() };

      const td = parseTransactionalData(event.transactionalData);
      if (td) {
        if (typeof td.asana_task_id === "string") contact.asana_task_id = td.asana_task_id;
        if (typeof td.business_name === "string") contact.business_name = td.business_name;
        if (typeof td.client_name === "string") contact.client_name = td.client_name;
      }

      messageToContact.set(event.messageId, contact);
      emailToContact.set(contact.email, contact);
    }

    // Step 2: fetch emailOpen events → join on messageId
    const openResponse = await iterableRequest(
      `/export/data.json?dataTypeName=emailOpen${commonParams}`
    );
    const openText = await openResponse.text();
    const openLines = openText.trim().split("\n").filter(Boolean);

    type OpenerStats = ContactInfo & {
      open_count: number;
      first_open: string;
      last_open: string;
    };

    // Key by asana_task_id if available, else email
    const openerMap = new Map<string, OpenerStats>();

    for (const line of openLines) {
      const event = JSON.parse(line) as {
        email?: string;
        messageId?: string;
        isBot?: boolean;
        createdAt?: string;
      };

      if (shouldExcludeBots && event.isBot) continue;
      if (!event.email) continue;

      // Prefer the messageId join, but fall back to matching the open's email
      // against the sent contacts so we resolve the same asana_task_id-keyed
      // contact that Step 3 will look up (avoids missing opens for contacts
      // with an asana_task_id whose open event has a missing/unmatched messageId).
      const emailLower = event.email.toLowerCase();
      const contact =
        (event.messageId ? messageToContact.get(event.messageId) : undefined) ??
        emailToContact.get(emailLower);

      const key = contact ? contactKey(contact) : emailLower;
      const existing = openerMap.get(key);

      if (existing) {
        existing.open_count++;
        if (event.createdAt && event.createdAt > existing.last_open) existing.last_open = event.createdAt;
        if (event.createdAt && event.createdAt < existing.first_open) existing.first_open = event.createdAt;
      } else {
        openerMap.set(key, {
          email: contact?.email ?? event.email.toLowerCase(),
          asana_task_id: contact?.asana_task_id,
          business_name: contact?.business_name,
          client_name: contact?.client_name,
          open_count: 1,
          first_open: event.createdAt ?? "",
          last_open: event.createdAt ?? "",
        });
      }
    }

    // Step 3: build full list of all sent contacts with opened flag
    const allContacts = Array.from(messageToContact.values());
    // Deduplicate by asana_task_id or email
    const seen = new Set<string>();
    const uniqueContacts: ContactInfo[] = [];
    for (const c of allContacts) {
      const key = contactKey(c);
      if (!seen.has(key)) { seen.add(key); uniqueContacts.push(c); }
    }

    const results = uniqueContacts.map((c) => {
      const openStats = openerMap.get(contactKey(c));
      return {
        asana_task_id: c.asana_task_id ?? null,
        email: c.email,
        business_name: c.business_name ?? null,
        client_name: c.client_name ?? null,
        opened: !!openStats,
        open_count: openStats?.open_count ?? 0,
        first_open: openStats?.first_open ?? null,
        last_open: openStats?.last_open ?? null,
      };
    }).sort((a, b) => (b.opened ? 1 : 0) - (a.opened ? 1 : 0));

    const opened = results.filter((r) => r.opened);
    const not_opened = results.filter((r) => !r.opened);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          campaign_id,
          total_sent: uniqueContacts.length,
          total_opened: opened.length,
          total_not_opened: not_opened.length,
          open_rate: uniqueContacts.length > 0
            ? `${((opened.length / uniqueContacts.length) * 100).toFixed(1)}%`
            : "0%",
          bots_excluded: shouldExcludeBots,
          opened,
          not_opened,
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "inspect_campaign_event_fields",
  "Inspect the raw fields available on emailOpen or emailSend events for a campaign. " +
    "Returns all fields from the first N events so you can discover what data is attached " +
    "(e.g. dataFields, custom attributes like Asana task IDs, userId, etc.). " +
    "Use this before building a cross-reference to know exactly which field holds the identifier.",
  {
    campaign_id: z.number().describe("The campaign ID to inspect events for."),
    start_date: z.string().describe("Start datetime in ISO 8601 format (e.g. '2026-05-01T00:00:00')."),
    end_date: z.string().describe("End datetime in ISO 8601 format (e.g. '2026-06-30T00:00:00')."),
    event_type: z
      .enum(["emailOpen", "emailSend", "emailClick"])
      .optional()
      .describe("Event type to inspect. Defaults to 'emailOpen'."),
    sample_size: z
      .number()
      .optional()
      .describe("Number of raw events to return for inspection. Defaults to 3."),
  },
  async ({ campaign_id, start_date, end_date, event_type, sample_size }) => {
    const dataTypeName = event_type ?? "emailOpen";
    const limit = sample_size ?? 3;

    const params = new URLSearchParams();
    params.append("dataTypeName", dataTypeName);
    params.append("startDateTime", `${start_date}.000Z`);
    params.append("endDateTime", `${end_date}.000Z`);
    params.append("campaignId", campaign_id.toString());

    const response = await iterableRequest(`/export/data.json?${params.toString()}`);
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean).slice(0, limit);

    const events = lines.map((line) => JSON.parse(line));
    const allKeys = Array.from(new Set(events.flatMap((e) => Object.keys(e)))).sort();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              campaign_id,
              event_type: dataTypeName,
              sample_count: events.length,
              available_fields: allKeys,
              sample_events: events,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_campaign_sends",
  "Get the list of unique email addresses that were sent a specific campaign. " +
    "Uses the Iterable data export API to pull all emailSend events for the campaign. " +
    "Optionally cross-references against a provided list of emails to identify which contacts " +
    "received the campaign (e.g. to verify Asana contacts were actually sent the email). " +
    "Rate limited — space requests 10-15 seconds apart.",
  {
    campaign_id: z.number().describe("The campaign ID to get send recipients for."),
    start_date: z
      .string()
      .describe(
        "Start datetime in ISO 8601 format (e.g. '2026-05-01T00:00:00'). " +
          "Should be on or before the campaign send date."
      ),
    end_date: z
      .string()
      .describe(
        "End datetime in ISO 8601 format (e.g. '2026-06-30T00:00:00'). " +
          "Should be after the campaign send date."
      ),
    match_emails: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of email addresses to cross-reference (e.g. from Asana contacts). " +
          "If provided, the response will include which of these emails received the campaign."
      ),
  },
  async ({ campaign_id, start_date, end_date, match_emails }) => {
    const params = new URLSearchParams();
    params.append("dataTypeName", "emailSend");
    params.append("startDateTime", `${start_date}.000Z`);
    params.append("endDateTime", `${end_date}.000Z`);
    params.append("campaignId", campaign_id.toString());

    const response = await iterableRequest(
      `/export/data.json?${params.toString()}`
    );
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);

    const recipientMap = new Map<string, { send_count: number; sent_at: string }>();

    for (const line of lines) {
      const event = JSON.parse(line) as {
        email?: string;
        createdAt?: string;
      };

      if (!event.email) continue;
      const email = event.email.toLowerCase();
      const existing = recipientMap.get(email);
      if (existing) {
        existing.send_count++;
      } else {
        recipientMap.set(email, {
          send_count: 1,
          sent_at: event.createdAt ?? "",
        });
      }
    }

    const recipients = Array.from(recipientMap.entries()).map(([email, stats]) => ({
      email,
      ...stats,
    }));

    const result: Record<string, unknown> = {
      campaign_id,
      total_send_events: lines.length,
      unique_recipients: recipients.length,
      recipients,
    };

    if (match_emails && match_emails.length > 0) {
      const recipientEmails = new Set(recipients.map((r) => r.email));
      const normalizedMatch = match_emails.map((e) => e.toLowerCase());
      const matched = normalizedMatch.filter((e) => recipientEmails.has(e));
      const not_matched = normalizedMatch.filter((e) => !recipientEmails.has(e));
      result.match_summary = {
        provided: match_emails.length,
        sent: matched.length,
        not_sent: not_matched.length,
        sent_emails: matched,
        not_sent_emails: not_matched,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
