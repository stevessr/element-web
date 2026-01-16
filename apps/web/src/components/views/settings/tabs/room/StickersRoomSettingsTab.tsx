/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo } from "react";
import { type AccountDataEvents, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";
import pako from "pako";
import Tar from "tar-js";

import { _t } from "../../../../../languageHandler";
import { MatrixClientPeg } from "../../../../../MatrixClientPeg";
import { useRoomState } from "../../../../../hooks/useRoomState";
import { useAccountData } from "../../../../../hooks/useAccountData";
import { EMOTE_ROOMS_EVENT_TYPE, ROOM_EMOTES_EVENT_TYPE } from "../../../../../utils/RoomEmotes";
import { mediaFromMxc } from "../../../../../customisations/Media";
import AccessibleButton from "../../../elements/AccessibleButton";
import LabelledCheckbox from "../../../elements/LabelledCheckbox";
import { SettingsSubsection, SettingsSubsectionText } from "../../shared/SettingsSubsection";
import Modal from "../../../../../Modal";
import QuestionDialog from "../../../dialogs/QuestionDialog";
import ErrorDialog from "../../../dialogs/ErrorDialog";
import StickersPackEditorDialog from "../../../dialogs/StickersPackEditorDialog";

interface EmoteRoomsContent {
    rooms?: Record<string, Record<string, unknown>>;
}

interface PackSummary {
    stateKey: string;
    displayName: string;
    imageCount: number;
    enabledGlobally: boolean;
    event: MatrixEvent;
}

const getImageUrl = (image: Record<string, unknown>): string => {
    const url = image.url;
    if (typeof url === "string") return url;
    const file = image.file;
    if (file && typeof file === "object" && typeof (file as { url?: unknown }).url === "string") {
        return (file as { url: string }).url;
    }
    return "";
};

const getExtensionForMime = (mime: string | null): string => {
    switch (mime) {
        case "image/png":
            return "png";
        case "image/jpeg":
            return "jpg";
        case "image/gif":
            return "gif";
        case "image/webp":
            return "webp";
        case "image/apng":
            return "apng";
        case "image/svg+xml":
            return "svg";
        default:
            return "png";
    }
};

const normalizeKey = (name: string): string => {
    const base = name.replace(/\.[^/.]+$/, "");
    return base.trim().replace(/\s+/g, "-");
};

export const StickersRoomSettingsTab: React.FC<{ room: Room }> = ({ room }) => {
    const client = MatrixClientPeg.safeGet();
    const accountData = useAccountData<EmoteRoomsContent>(
        client,
        EMOTE_ROOMS_EVENT_TYPE as unknown as keyof AccountDataEvents,
    );

    const roomEmoteEvents = useRoomState(room, (state) => {
        const events = state.getStateEvents(ROOM_EMOTES_EVENT_TYPE);
        if (!events) return [] as MatrixEvent[];
        return Array.isArray(events) ? events : [events];
    });

    const enabledRoomState = useMemo(() => accountData.rooms ?? {}, [accountData.rooms]);
    const canEdit = room.currentState.maySendStateEvent(
        ROOM_EMOTES_EVENT_TYPE,
        client.getSafeUserId(),
    );

    const packs = useMemo<PackSummary[]>(() => {
        return [...roomEmoteEvents]
            .sort((a, b) => (a.getStateKey() || "").localeCompare(b.getStateKey() || ""))
            .map((event) => {
                const stateKey = event.getStateKey() || "";
                const content = event.getContent() ?? {};
                const pack = typeof content.pack === "object" && content.pack ? content.pack : {};
                const images = typeof content.images === "object" && content.images ? content.images : {};
                const imageCount = Object.keys(images as Record<string, unknown>).length;
                const displayName =
                    (typeof (pack as { display_name?: unknown }).display_name === "string"
                        ? (pack as { display_name: string }).display_name
                        : undefined) || stateKey || _t("common|stickerpack");
                return {
                    stateKey,
                    displayName,
                    imageCount,
                    enabledGlobally: Boolean(enabledRoomState[room.roomId]?.[stateKey]),
                    event,
                };
            });
    }, [roomEmoteEvents, enabledRoomState, room.roomId]);

    const startEditPack = (event?: MatrixEvent): void => {
        Modal.createDialog(StickersPackEditorDialog, {
            room,
            event,
            enabledGlobally: event ? Boolean(enabledRoomState[room.roomId]?.[event.getStateKey() || ""]) : false,
        });
    };

    const setGlobalEnabled = async (stateKey: string, enabled: boolean): Promise<void> => {
        const content: EmoteRoomsContent = client.getAccountData(EMOTE_ROOMS_EVENT_TYPE)?.getContent() ?? {};
        if (!content.rooms || typeof content.rooms !== "object") content.rooms = {};
        const roomEntry = (content.rooms[room.roomId] ?? {}) as Record<string, unknown>;

        if (enabled) {
            roomEntry[stateKey] = roomEntry[stateKey] ?? {};
        } else {
            delete roomEntry[stateKey];
        }

        if (Object.keys(roomEntry).length) {
            content.rooms[room.roomId] = roomEntry;
        } else {
            delete content.rooms[room.roomId];
        }

        await client.setAccountData(EMOTE_ROOMS_EVENT_TYPE, content);
    };

    const updateGlobalEnabled = async (stateKey: string, enabled: boolean): Promise<void> => {
        try {
            await setGlobalEnabled(stateKey, enabled);
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|save_error_title"),
                description: _t("room_settings|stickers|save_error_description"),
            });
        }
    };

    const removePack = async (event: MatrixEvent): Promise<void> => {
        const stateKey = event.getStateKey() || "";
        const { finished } = Modal.createDialog(QuestionDialog, {
            title: _t("room_settings|stickers|delete_title"),
            description: _t("room_settings|stickers|delete_description", { stateKey }),
            button: _t("action|remove"),
        });
        const [confirmed] = await finished;
        if (!confirmed) return;

        try {
            await room.client.sendStateEvent(room.roomId, ROOM_EMOTES_EVENT_TYPE, { images: {}, pack: {} }, stateKey);
            await setGlobalEnabled(stateKey, false);
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|delete_error_title"),
                description: _t("room_settings|stickers|delete_error_description"),
            });
        }
    };

    const exportPack = async (event: MatrixEvent, displayName: string): Promise<void> => {
        try {
            const content = event.getContent() ?? {};
            const images = typeof content.images === "object" && content.images ? content.images : {};
            const entries = Object.entries(images as Record<string, Record<string, unknown>>).sort(([a], [b]) =>
                a.localeCompare(b),
            );
            const tar = new Tar();

            for (const [key, image] of entries) {
                const url = getImageUrl(image);
                if (!url) continue;
                const http = mediaFromMxc(url).srcHttp;
                if (!http) continue;
                const response = await fetch(http);
                if (!response.ok) continue;
                const data = new Uint8Array(await response.arrayBuffer());
                const ext = getExtensionForMime(response.headers.get("content-type"));
                tar.append(`${key}.${ext}`, data);
            }

            const gzipped = pako.gzip(tar.out);
            const blob = new Blob([gzipped], { type: "application/gzip" });
            const filename = `${normalizeKey(displayName || "sticker-pack")}.tar.gz`;

            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|export_error_title"),
                description: _t("room_settings|stickers|export_error_description"),
            });
        }
    };

    return (
        <div className="mx_StickersRoomSettingsTab">
            <SettingsSubsection
                heading={_t("room_settings|stickers|title")}
                description={_t("room_settings|stickers|description")}
            >
                <SettingsSubsectionText>{_t("room_settings|stickers|list_description")}</SettingsSubsectionText>
                <div className="mx_StickersRoomSettingsTab_list">
                    {packs.length === 0 && (
                        <div className="mx_StickersRoomSettingsTab_empty">
                            {_t("room_settings|stickers|empty")}
                        </div>
                    )}
                    {packs.map((pack) => (
                        <div className="mx_StickersRoomSettingsTab_row" key={pack.stateKey}>
                            <div className="mx_StickersRoomSettingsTab_rowInfo">
                                <div className="mx_StickersRoomSettingsTab_rowTitle">{pack.displayName}</div>
                                <div className="mx_StickersRoomSettingsTab_rowMeta">
                                    {_t("room_settings|stickers|row_meta", {
                                        stateKey: pack.stateKey || _t("room_settings|stickers|unnamed"),
                                        count: pack.imageCount,
                                    })}
                                </div>
                            </div>
                            <div className="mx_StickersRoomSettingsTab_rowActions">
                                <LabelledCheckbox
                                    className="mx_StickersRoomSettingsTab_rowToggle"
                                    label={_t("room_settings|stickers|enable_global")}
                                    value={pack.enabledGlobally}
                                    onChange={(checked) => void updateGlobalEnabled(pack.stateKey, checked)}
                                />
                                <AccessibleButton
                                    kind="secondary"
                                    onClick={() => void exportPack(pack.event, pack.displayName)}
                                >
                                    {_t("room_settings|stickers|export_pack")}
                                </AccessibleButton>
                                <AccessibleButton
                                    kind="secondary"
                                    disabled={!canEdit}
                                    onClick={() => startEditPack(pack.event)}
                                >
                                    {_t("action|edit")}
                                </AccessibleButton>
                                <AccessibleButton
                                    kind="danger_outline"
                                    disabled={!canEdit}
                                    onClick={() => removePack(pack.event)}
                                >
                                    {_t("action|remove")}
                                </AccessibleButton>
                            </div>
                        </div>
                    ))}
                </div>
                <AccessibleButton kind="primary" disabled={!canEdit} onClick={() => startEditPack()}>
                    {_t("room_settings|stickers|add_pack")}
                </AccessibleButton>
                {!canEdit && (
                    <SettingsSubsectionText className="mx_StickersRoomSettingsTab_hint">
                        {_t("room_settings|stickers|no_permission")}
                    </SettingsSubsectionText>
                )}
            </SettingsSubsection>
        </div>
    );
};

export default StickersRoomSettingsTab;
