/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient, type Room, type MatrixEvent, type ImageInfo } from "matrix-js-sdk/src/matrix";

export const ROOM_EMOTES_EVENT_TYPE = "im.ponies.room_emotes";
export const USER_EMOTES_EVENT_TYPE = "im.ponies.user_emotes";
export const EMOTE_ROOMS_EVENT_TYPE = "im.ponies.emote_rooms";

export type RoomEmoteUsage = "sticker" | "emoticon";

export interface RoomEmoteImage {
    key: string;
    url: string;
    body: string;
    info?: ImageInfo;
}

export interface RoomEmotePack {
    id: string;
    displayName: string;
    avatarUrl?: string;
    images: RoomEmoteImage[];
    roomId?: string;
    stateKey?: string;
}

const sortStateEvents = (events: MatrixEvent[]): MatrixEvent[] => {
    return [...events].sort((a, b) => (a.getStateKey() || "").localeCompare(b.getStateKey() || ""));
};

const getStateEvents = (room: Room): MatrixEvent[] => {
    const events = room.currentState.getStateEvents(ROOM_EMOTES_EVENT_TYPE);
    if (!events) return [];
    return sortStateEvents(Array.isArray(events) ? events : [events]);
};

const hasUsage = (usage: unknown, wanted: RoomEmoteUsage): boolean => {
    if (!usage) return true;
    if (Array.isArray(usage)) return usage.includes(wanted);
    return false;
};

const getImageUrl = (image: Record<string, unknown>): string | undefined => {
    const url = image.url;
    if (typeof url === "string") return url;
    const file = image.file;
    if (file && typeof file === "object" && typeof (file as { url?: unknown }).url === "string") {
        return (file as { url: string }).url;
    }
    return undefined;
};

const parsePackContent = (
    content: Record<string, unknown>,
    usage: RoomEmoteUsage,
    id: string,
    roomId?: string,
    stateKey?: string,
): RoomEmotePack | null => {
    const images = typeof content.images === "object" && content.images ? content.images : {};
    const pack = typeof content.pack === "object" && content.pack ? content.pack : {};

    const entries = Object.entries(images as Record<string, Record<string, unknown>>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, image]) => {
            if (!hasUsage(image.usage, usage)) return null;
            const url = getImageUrl(image);
            if (!url) return null;
            const body = typeof image.body === "string" ? image.body : key;
            const info = typeof image.info === "object" && image.info ? (image.info as ImageInfo) : undefined;
            return { key, url, body, info } as RoomEmoteImage;
        })
        .filter((image): image is RoomEmoteImage => !!image);

    if (!entries.length) return null;

    const displayName =
        (typeof (pack as { display_name?: unknown }).display_name === "string"
            ? (pack as { display_name: string }).display_name
            : undefined) ||
        stateKey ||
        "";
    const avatarUrl =
        typeof (pack as { avatar_url?: unknown }).avatar_url === "string"
            ? (pack as { avatar_url: string }).avatar_url
            : undefined;

    return {
        id: id || displayName || "pack",
        displayName,
        avatarUrl,
        images: entries,
        roomId,
        stateKey,
    };
};

export const getRoomEmotePacks = (room: Room, usage: RoomEmoteUsage): RoomEmotePack[] => {
    const packs: RoomEmotePack[] = [];
    for (const event of getStateEvents(room)) {
        const content = event.getContent() ?? {};
        const stateKey = event.getStateKey() || "";
        const pack = parsePackContent(
            content,
            usage,
            stateKey || event.getId() || "",
            room.roomId,
            stateKey,
        );
        if (pack) packs.push(pack);
    }

    return packs;
};

export const hasRoomEmotePacks = (room: Room, usage: RoomEmoteUsage): boolean => {
    return getRoomEmotePacks(room, usage).length > 0;
};

export const getEnabledRoomEmotePacks = (
    client: MatrixClient,
    currentRoom: Room,
    usage: RoomEmoteUsage,
): Array<{ room: Room; packs: RoomEmotePack[] }> => {
    const content = client.getAccountData(EMOTE_ROOMS_EVENT_TYPE)?.getContent<Record<string, unknown>>() ?? {};
    const rooms = (content.rooms && typeof content.rooms === "object" ? content.rooms : {}) as Record<
        string,
        Record<string, unknown>
    >;

    const results: Array<{ room: Room; packs: RoomEmotePack[] }> = [];
    for (const [roomId, stateKeysValue] of Object.entries(rooms)) {
        if (roomId === currentRoom.roomId) continue;
        const room = client.getRoom(roomId);
        if (!room) continue;
        const stateKeys = Object.keys(stateKeysValue || {}).sort((a, b) => a.localeCompare(b));
        const packs: RoomEmotePack[] = [];
        for (const stateKey of stateKeys) {
            const event = room.currentState.getStateEvents(ROOM_EMOTES_EVENT_TYPE, stateKey);
            if (!event) continue;
            const pack = parsePackContent(
                event.getContent() ?? {},
                usage,
                `${roomId}:${stateKey}`,
                roomId,
                stateKey,
            );
            if (pack) packs.push(pack);
        }
        if (packs.length) {
            results.push({ room, packs });
        }
    }

    results.sort((a, b) => (a.room.name || a.room.roomId).localeCompare(b.room.name || b.room.roomId));
    return results;
};

export const getUserEmotePack = (client: MatrixClient, usage: RoomEmoteUsage): RoomEmotePack | null => {
    const content = client.getAccountData(USER_EMOTES_EVENT_TYPE)?.getContent<Record<string, unknown>>() ?? {};
    return parsePackContent(content, usage, "user", undefined, "user");
};
