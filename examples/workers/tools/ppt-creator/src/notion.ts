import type { Client } from "@notionhq/client";
import type { Slide, RichText } from "./types.js";

export async function getPageTitle(notion: Client, pageId: string): Promise<string> {
	const page = (await notion.pages.retrieve({ page_id: pageId })) as Record<
		string,
		any
	>;
	const titleProp = Object.values(
		page.properties as Record<string, any>,
	).find((p: any) => p.type === "title") as any;
	return (
		titleProp?.title
			?.map((rt: { plain_text: string }) => rt.plain_text)
			.join("") ?? "Untitled"
	);
}

export function extractPageId(input: string): string {
	const clean = input.replace(/-/g, "");
	const match = clean.match(/([a-f0-9]{32})/i);
	return match ? match[1] : input;
}

export function plainText(richText: RichText[]): string {
	return richText.map((t) => t.plain_text).join("");
}

export async function getAllBlocks(notion: Client, blockId: string) {
	const blocks: Array<Record<string, any>> = [];
	let cursor: string | undefined;
	do {
		const response = await notion.blocks.children.list({
			block_id: blockId,
			start_cursor: cursor,
			page_size: 100,
		});
		blocks.push(...(response.results as Array<Record<string, any>>));
		cursor = response.has_more
			? (response.next_cursor ?? undefined)
			: undefined;
	} while (cursor);
	return blocks;
}

export function groupBlocksIntoSlides(
	blocks: Array<Record<string, any>>,
	pageTitle: string,
): Slide[] {
	const slides: Slide[] = [];
	let current: Slide | null = null;

	for (const block of blocks) {
		const type: string = block.type;
		const data = block[type];

		if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
			if (current) slides.push(current);
			current = { title: plainText(data.rich_text), items: [] };
			continue;
		}

		if (!current) {
			current = { title: pageTitle, items: [] };
		}

		switch (type) {
			case "paragraph": {
				const text = plainText(data.rich_text);
				if (text) current.items.push({ text, type: "text" });
				break;
			}
			case "bulleted_list_item": {
				const text = plainText(data.rich_text);
				if (text) current.items.push({ text, type: "bullet" });
				break;
			}
			case "numbered_list_item": {
				const text = plainText(data.rich_text);
				if (text) current.items.push({ text, type: "numbered" });
				break;
			}
			case "to_do": {
				const text = plainText(data.rich_text);
				if (text)
					current.items.push({
						text,
						type: "todo",
						checked: data.checked,
					});
				break;
			}
			case "code": {
				const text = plainText(data.rich_text);
				if (text) current.items.push({ text, type: "code" });
				break;
			}
			case "quote": {
				const text = plainText(data.rich_text);
				if (text) current.items.push({ text, type: "quote" });
				break;
			}
		}
	}

	if (current) slides.push(current);
	return slides;
}

// --- Markdown API approach (single call, no pagination) ---

export async function getPageMarkdown(pageId: string): Promise<string> {
	const baseUrl = process.env.NOTION_API_BASE_URL ?? "https://api.notion.com";
	const token = process.env.NOTION_API_TOKEN;

	const res = await fetch(`${baseUrl}/v1/pages/${pageId}/markdown`, {
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": "2026-03-11",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to fetch page markdown: ${res.status} ${body}`);
	}

	const data = (await res.json()) as { markdown: string };
	return data.markdown;
}

function cleanText(text: string): string {
	return text
		.replace(/\\([^\\])/g, "$1")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.trim();
}

export function groupMarkdownIntoSlides(
	markdown: string,
	pageTitle: string,
): Slide[] {
	const lines = markdown.split("\n");
	const slides: Slide[] = [];
	let current: Slide | null = null;
	let inCodeBlock = false;
	let codeBuffer: string[] = [];

	for (const line of lines) {
		if (line.startsWith("```")) {
			if (inCodeBlock) {
				if (current && codeBuffer.length > 0) {
					current.items.push({
						text: codeBuffer.join("\n"),
						type: "code",
					});
				}
				codeBuffer = [];
			}
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) {
			codeBuffer.push(line);
			continue;
		}

		// Skip lines that are just HTML/Notion tags (callout, file, etc.)
		if (/^\s*<\/?[a-z][^>]*>\s*$/i.test(line)) continue;

		// Headings start new slides
		const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
		if (headingMatch) {
			if (current) slides.push(current);
			current = {
				title: cleanText(headingMatch[2].trim()),
				items: [],
			};
			continue;
		}

		// Skip horizontal rules / dividers
		if (/^[-*_]{3,}\s*$/.test(line.trim())) continue;

		if (!current) {
			current = { title: pageTitle, items: [] };
		}

		// To-do items (must check before bullets)
		const todoMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
		if (todoMatch) {
			const text = cleanText(todoMatch[2].trim());
			if (text)
				current.items.push({
					text,
					type: "todo",
					checked: todoMatch[1] !== " ",
				});
			continue;
		}

		// Bullet lists
		const bulletMatch = line.match(/^[-*]\s+(.*)/);
		if (bulletMatch) {
			const text = cleanText(bulletMatch[1].trim());
			if (text) current.items.push({ text, type: "bullet" });
			continue;
		}

		// Numbered lists
		const numberedMatch = line.match(/^\d+\.\s+(.*)/);
		if (numberedMatch) {
			const text = cleanText(numberedMatch[1].trim());
			if (text) current.items.push({ text, type: "numbered" });
			continue;
		}

		// Quotes
		const quoteMatch = line.match(/^>\s+(.*)/);
		if (quoteMatch) {
			const text = cleanText(quoteMatch[1].trim());
			if (text) current.items.push({ text, type: "quote" });
			continue;
		}

		// Regular text (skip empty lines)
		const text = cleanText(line.trim());
		if (text) current.items.push({ text, type: "text" });
	}

	if (current) slides.push(current);
	return slides;
}

// --- Upload ---

export async function uploadToNotion(
	pageId: string,
	filename: string,
	buffer: Buffer,
	message: string,
): Promise<void> {
	const baseUrl = process.env.NOTION_API_BASE_URL ?? "https://api.notion.com";
	const token = process.env.NOTION_API_TOKEN;
	const version = "2026-03-11";

	// Step 1: Create file upload
	const createRes = await fetch(`${baseUrl}/v1/file_uploads`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": version,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			filename,
			content_type:
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		}),
	});
	if (!createRes.ok) {
		const body = await createRes.text();
		throw new Error(`Failed to create file upload: ${createRes.status} ${body}`);
	}
	const { id: uploadId } = (await createRes.json()) as { id: string };

	// Step 2: Send file bytes
	const formData = new FormData();
	const mimeType =
		"application/vnd.openxmlformats-officedocument.presentationml.presentation";
	formData.append(
		"file",
		new Blob([new Uint8Array(buffer)], { type: mimeType }),
		filename,
	);

	const sendRes = await fetch(`${baseUrl}/v1/file_uploads/${uploadId}/send`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": version,
		},
		body: formData,
	});
	if (!sendRes.ok) {
		const body = await sendRes.text();
		throw new Error(`Failed to upload file: ${sendRes.status} ${body}`);
	}

	// Step 3: Add as a page comment with the file attached
	const commentRes = await fetch(`${baseUrl}/v1/comments`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": version,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			parent: { page_id: pageId },
			rich_text: [{ text: { content: message } }],
			attachments: [
				{ type: "file_upload", file_upload_id: uploadId },
			],
		}),
	});
	if (!commentRes.ok) {
		const body = await commentRes.text();
		throw new Error(`Failed to create comment: ${commentRes.status} ${body}`);
	}
}
