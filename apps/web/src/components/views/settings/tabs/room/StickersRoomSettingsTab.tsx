/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useMemo, useState } from "react";
import { type AccountDataEvents, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../../../../../languageHandler";
import { MatrixClientPeg } from "../../../../../MatrixClientPeg";
import { useRoomState } from "../../../../../hooks/useRoomState";
import { useAccountData } from "../../../../../hooks/useAccountData";
import { EMOTE_ROOMS_EVENT_TYPE, ROOM_EMOTES_EVENT_TYPE } from "../../../../../utils/RoomEmotes";
import Field from "../../../elements/Field";
import AccessibleButton from "../../../elements/AccessibleButton";
import LabelledCheckbox from "../../../elements/LabelledCheckbox";
import { SettingsSubsection, SettingsSubsectionText } from "../../shared/SettingsSubsection";
import Modal from "../../../../../Modal";
import QuestionDialog from "../../../dialogs/QuestionDialog";
import ErrorDialog from "../../../dialogs/ErrorDialog";

interface EmoteRoomsContent {
    rooms?: Record<string, Record<string, unknown>>;
}

interface EditableImage {
    key: string;
    url: string;
    body: string;
    usageSticker: boolean;
    usageEmoticon: boolean;
    info?: Record<string, unknown>;
}

interface EditablePack {
    originalStateKey?: string;
    originalEnabledGlobally?: boolean;
    stateKey: string;
    displayName: string;
    attribution: string;
    avatarUrl: string;
    images: EditableImage[];
    enableGlobally: boolean;
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

const getUsageFlags = (usage: unknown): { sticker: boolean; emoticon: boolean } => {
    if (!usage) return { sticker: true, emoticon: true };
    if (Array.isArray(usage)) {
        return {
            sticker: usage.includes("sticker"),
            emoticon: usage.includes("emoticon"),
        };
    }
    return { sticker: true, emoticon: true };
};

const emptyImage = (): EditableImage => ({
    key: "",
    url: "",
    body: "",
    usageSticker: true,
    usageEmoticon: false,
});

const emptyPack = (): EditablePack => ({
    stateKey: "",
    displayName: "",
    attribution: "",
    avatarUrl: "",
    images: [emptyImage()],
    enableGlobally: false,
});

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

    const [editingPack, setEditingPack] = useState<EditablePack | null>(null);
    const [isSaving, setIsSaving] = useState(false);

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
                const displayName =
                    (typeof (pack as { display_name?: unknown }).display_name === "string"
                        ? (pack as { display_name: string }).display_name
                        : undefined) || stateKey || _t("common|stickerpack");
                return {
                    stateKey,
                    displayName,
                    imageCount: Object.keys(images as Record<string, unknown>).length,
                    enabledGlobally: Boolean(enabledRoomState[room.roomId]?.[stateKey]),
                    event,
                };
            });
    }, [roomEmoteEvents, enabledRoomState, room.roomId]);

    const startEditPack = (event?: MatrixEvent): void => {
        if (!event) {
            setEditingPack(emptyPack());
            return;
        }
        const stateKey = event.getStateKey() || "";
        const content = event.getContent() ?? {};
        const pack = typeof content.pack === "object" && content.pack ? content.pack : {};
        const images = typeof content.images === "object" && content.images ? content.images : {};
        const displayName =
            (typeof (pack as { display_name?: unknown }).display_name === "string"
                ? (pack as { display_name: string }).display_name
                : undefined) || "";
        const attribution =
            typeof (pack as { attribution?: unknown }).attribution === "string"
                ? (pack as { attribution: string }).attribution
                : "";
        const avatarUrl =
            typeof (pack as { avatar_url?: unknown }).avatar_url === "string"
                ? (pack as { avatar_url: string }).avatar_url
                : "";

        const imageList = Object.entries(images as Record<string, Record<string, unknown>>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, image]) => {
                const usage = getUsageFlags(image.usage);
                return {
                    key,
                    url: getImageUrl(image),
                    body: typeof image.body === "string" ? image.body : "",
                    usageSticker: usage.sticker,
                    usageEmoticon: usage.emoticon,
                    info: typeof image.info === "object" && image.info ? (image.info as Record<string, unknown>) : undefined,
                };
            });

        setEditingPack({
            originalStateKey: stateKey,
            originalEnabledGlobally: Boolean(enabledRoomState[room.roomId]?.[stateKey]),
            stateKey,
            displayName,
            attribution,
            avatarUrl,
            images: imageList.length ? imageList : [emptyImage()],
            enableGlobally: Boolean(enabledRoomState[room.roomId]?.[stateKey]),
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

    const saveEditingPack = async (): Promise<void> => {
        if (!editingPack) return;
        const stateKey = editingPack.stateKey.trim();
        if (!stateKey) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|missing_state_key_title"),
                description: _t("room_settings|stickers|missing_state_key_description"),
            });
            return;
        }

        const images: Record<string, Record<string, unknown>> = {};
        for (const image of editingPack.images) {
            const key = image.key.trim();
            const url = image.url.trim();
            if (!key || !url) continue;
            const usage: string[] = [];
            if (image.usageSticker) usage.push("sticker");
            if (image.usageEmoticon) usage.push("emoticon");
            if (!usage.length) continue;
            const entry: Record<string, unknown> = { url };
            if (image.body.trim()) entry.body = image.body.trim();
            if (usage.length === 1) entry.usage = usage;
            if (image.info) entry.info = image.info;
            images[key] = entry;
        }

        const packMeta: Record<string, unknown> = {};
        if (editingPack.displayName.trim()) packMeta.display_name = editingPack.displayName.trim();
        if (editingPack.attribution.trim()) packMeta.attribution = editingPack.attribution.trim();
        if (editingPack.avatarUrl.trim()) packMeta.avatar_url = editingPack.avatarUrl.trim();

        const content: Record<string, unknown> = {};
        if (Object.keys(packMeta).length) content.pack = packMeta;
        if (Object.keys(images).length) content.images = images;

        setIsSaving(true);
        try {
            if (editingPack.originalStateKey && editingPack.originalStateKey !== stateKey) {
                await room.client.sendStateEvent(room.roomId, ROOM_EMOTES_EVENT_TYPE, {}, editingPack.originalStateKey);
            }
            await room.client.sendStateEvent(room.roomId, ROOM_EMOTES_EVENT_TYPE, content, stateKey);
            if (editingPack.originalStateKey && editingPack.originalStateKey !== stateKey) {
                if (editingPack.originalEnabledGlobally) {
                    await setGlobalEnabled(editingPack.originalStateKey, false);
                }
            }
            await setGlobalEnabled(stateKey, editingPack.enableGlobally);
            setEditingPack(null);
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|save_error_title"),
                description: _t("room_settings|stickers|save_error_description"),
            });
        } finally {
            setIsSaving(false);
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
            await room.client.sendStateEvent(room.roomId, ROOM_EMOTES_EVENT_TYPE, {}, stateKey);
            await setGlobalEnabled(stateKey, false);
            if (editingPack?.originalStateKey === stateKey) {
                setEditingPack(null);
            }
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|delete_error_title"),
                description: _t("room_settings|stickers|delete_error_description"),
            });
        }
    };

    const updateEditingPack = (patch: Partial<EditablePack>): void => {
        setEditingPack((current) => (current ? { ...current, ...patch } : current));
    };

    const updateImage = (index: number, patch: Partial<EditableImage>): void => {
        setEditingPack((current) => {
            if (!current) return current;
            const nextImages = [...current.images];
            nextImages[index] = { ...nextImages[index], ...patch };
            return { ...current, images: nextImages };
        });
    };

    const addImage = (): void => {
        setEditingPack((current) => (current ? { ...current, images: [...current.images, emptyImage()] } : current));
    };

    const removeImage = (index: number): void => {
        setEditingPack((current) => {
            if (!current) return current;
            const nextImages = current.images.filter((_, i) => i !== index);
            return { ...current, images: nextImages.length ? nextImages : [emptyImage()] };
        });
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

            {editingPack && (
                <SettingsSubsection
                    heading={_t("room_settings|stickers|editor_title")}
                    description={_t("room_settings|stickers|editor_description")}
                >
                    <div className="mx_StickersRoomSettingsTab_editor">
                        <div className="mx_StickersRoomSettingsTab_editorFields">
                            <Field
                                label={_t("room_settings|stickers|state_key")}
                                value={editingPack.stateKey}
                                onChange={(ev) =>
                                    updateEditingPack({ stateKey: (ev.target as HTMLInputElement).value })
                                }
                            />
                            <Field
                                label={_t("room_settings|stickers|display_name")}
                                value={editingPack.displayName}
                                onChange={(ev) =>
                                    updateEditingPack({ displayName: (ev.target as HTMLInputElement).value })
                                }
                            />
                            <Field
                                label={_t("room_settings|stickers|attribution")}
                                value={editingPack.attribution}
                                onChange={(ev) =>
                                    updateEditingPack({ attribution: (ev.target as HTMLInputElement).value })
                                }
                            />
                            <Field
                                label={_t("room_settings|stickers|avatar_url")}
                                value={editingPack.avatarUrl}
                                onChange={(ev) =>
                                    updateEditingPack({ avatarUrl: (ev.target as HTMLInputElement).value })
                                }
                            />
                        </div>
                        <LabelledCheckbox
                            className="mx_StickersRoomSettingsTab_editorToggle"
                            label={_t("room_settings|stickers|enable_global")}
                            value={editingPack.enableGlobally}
                            onChange={(checked) => updateEditingPack({ enableGlobally: checked })}
                        />
                        <div className="mx_StickersRoomSettingsTab_images">
                            <div className="mx_StickersRoomSettingsTab_imagesHeader">
                                {_t("room_settings|stickers|images_title")}
                            </div>
                            {editingPack.images.map((image, index) => (
                                <div className="mx_StickersRoomSettingsTab_imageRow" key={`image_${index}`}>
                                    <Field
                                        label={_t("room_settings|stickers|image_key")}
                                        value={image.key}
                                        onChange={(ev) =>
                                            updateImage(index, { key: (ev.target as HTMLInputElement).value })
                                        }
                                    />
                                    <Field
                                        label={_t("room_settings|stickers|image_url")}
                                        value={image.url}
                                        onChange={(ev) =>
                                            updateImage(index, { url: (ev.target as HTMLInputElement).value })
                                        }
                                    />
                                    <Field
                                        label={_t("room_settings|stickers|image_body")}
                                        value={image.body}
                                        onChange={(ev) =>
                                            updateImage(index, { body: (ev.target as HTMLInputElement).value })
                                        }
                                    />
                                    <div className="mx_StickersRoomSettingsTab_imageUsage">
                                        <LabelledCheckbox
                                            label={_t("room_settings|stickers|usage_sticker")}
                                            value={image.usageSticker}
                                            onChange={(checked) => updateImage(index, { usageSticker: checked })}
                                        />
                                        <LabelledCheckbox
                                            label={_t("room_settings|stickers|usage_emoticon")}
                                            value={image.usageEmoticon}
                                            onChange={(checked) => updateImage(index, { usageEmoticon: checked })}
                                        />
                                    </div>
                                    <AccessibleButton
                                        kind="danger_inline"
                                        onClick={() => removeImage(index)}
                                    >
                                        {_t("action|remove")}
                                    </AccessibleButton>
                                </div>
                            ))}
                            <AccessibleButton kind="secondary" onClick={addImage}>
                                {_t("room_settings|stickers|add_image")}
                            </AccessibleButton>
                        </div>
                        <div className="mx_StickersRoomSettingsTab_editorActions">
                            <AccessibleButton kind="primary" disabled={!canEdit || isSaving} onClick={saveEditingPack}>
                                {_t("action|save")}
                            </AccessibleButton>
                            <AccessibleButton
                                kind="secondary"
                                disabled={isSaving}
                                onClick={() => setEditingPack(null)}
                            >
                                {_t("action|cancel")}
                            </AccessibleButton>
                        </div>
                    </div>
                </SettingsSubsection>
            )}
        </div>
    );
};

export default StickersRoomSettingsTab;
