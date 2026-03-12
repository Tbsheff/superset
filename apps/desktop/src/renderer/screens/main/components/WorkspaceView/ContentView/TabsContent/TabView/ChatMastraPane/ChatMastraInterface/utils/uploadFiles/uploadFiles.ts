import type { FileUIPart } from "ai";
import { vanillaElectronTrpc } from "renderer/lib/vanilla-electron-trpc";

async function uploadFile(
	sessionId: string,
	file: FileUIPart,
): Promise<FileUIPart> {
	const result = await vanillaElectronTrpc.data.chat.uploadAttachment.mutate({
		sessionId,
		fileData: file.url,
		fileName: file.filename || "attachment",
		mediaType: file.mediaType,
	});

	return {
		type: "file",
		url: result.url,
		mediaType: result.mediaType,
		filename: result.filename,
	};
}

export async function uploadFiles(
	sessionId: string,
	files: FileUIPart[],
): Promise<FileUIPart[]> {
	if (files.length === 0) return [];
	return Promise.all(files.map((file) => uploadFile(sessionId, file)));
}
