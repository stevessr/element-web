/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef, useState } from "react";
import { type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";
import pako from "pako";
import Tar from "tar-js";

import { _t } from "../../../languageHandler";
import BaseDialog from "./BaseDialog";
import Field from "../elements/Field";
import AccessibleButton from "../elements/AccessibleButton";
import LabelledCheckbox from "../elements/LabelledCheckbox";
import { mediaFromMxc } from "../../../customisations/Media";
import Modal from "../../../Modal";
import ErrorDialog from "./ErrorDialog";
import { EMOTE_ROOMS_EVENT_TYPE, ROOM_EMOTES_EVENT_TYPE } from "../../../utils/RoomEmotes";

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

interface IProps {
    room: Room;
    event?: MatrixEvent;
    enabledGlobally?: boolean;
    onFinished: (success?: boolean) => void;
}

const emptyImage = (usage: "sticker" | "emoticon" = "sticker"): EditableImage => ({
    key: "",
    url: "",
    body: "",
    usageSticker: usage === "sticker",
    usageEmoticon: usage === "emoticon",
});

const normalizeKey = (name: string): string => {
    const base = name.replace(/\.[^/.]+$/, "");
    return base.trim().replace(/\s+/g, "-");
};

const nextUniqueKey = (desired: string, existing: Set<string>): string => {
    if (!existing.has(desired)) return desired;
    let counter = 2;
    let candidate = `${desired}-${counter}`;
    while (existing.has(candidate)) {
        counter += 1;
        candidate = `${desired}-${counter}`;
    }
    return candidate;
};

const getImageUrl = (image: Record<string, unknown>): string => {
    const url = image.url;
    if (typeof url === "string") return url;
    const file = image.file;
    if (file && typeof file === "object" && typeof (file as { url?: unknown }).url === "string") {
        return (file as { url: string }).url;
    }
    return "";
};

const getMimeForExtension = (ext: string): string => {
    switch (ext.toLowerCase()) {
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "apng":
            return "image/apng";
        case "svg":
            return "image/svg+xml";
        default:
            return "application/octet-stream";
    }
};

const decodeAscii = (bytes: Uint8Array, start: number, length: number): string => {
    let out = "";
    for (let i = start; i < start + length; i += 1) {
        const code = bytes[i];
        if (!code) break;
        out += String.fromCharCode(code);
    }
    return out;
};

const parseTar = (bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> => {
    const files: Array<{ name: string; data: Uint8Array }> = [];
    let offset = 0;
    while (offset + 512 <= bytes.length) {
        let isEmpty = true;
        for (let i = 0; i < 512; i += 1) {
            if (bytes[offset + i] !== 0) {
                isEmpty = false;
                break;
            }
        }
        if (isEmpty) break;

        const name = decodeAscii(bytes, offset, 100).trim();
        const sizeField = decodeAscii(bytes, offset + 124, 12).trim();
        const size = sizeField ? parseInt(sizeField, 8) : 0;
        const typeFlag = decodeAscii(bytes, offset + 156, 1);

        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        if (typeFlag !== "5" && name) {
            files.push({ name, data: bytes.slice(dataStart, dataEnd) });
        }

        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return files;
};

const buildPackFromEvent = (
    room: Room,
    event?: MatrixEvent,
    enabledGlobally?: boolean,
): EditablePack => {
    if (!event) {
        return {
            stateKey: "",
            displayName: "",
            attribution: "",
            avatarUrl: "",
            images: [emptyImage("sticker")],
            enableGlobally: false,
        };
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
        .map(([key, image]) => ({
            key,
            url: getImageUrl(image),
            body: typeof image.body === "string" ? image.body : "",
            usageSticker: !image.usage || (Array.isArray(image.usage) && image.usage.includes("sticker")),
            usageEmoticon: !image.usage || (Array.isArray(image.usage) && image.usage.includes("emoticon")),
            info: typeof image.info === "object" && image.info ? (image.info as Record<string, unknown>) : undefined,
        }));

    return {
        originalStateKey: stateKey,
        originalEnabledGlobally: Boolean(enabledGlobally),
        stateKey,
        displayName,
        attribution,
        avatarUrl,
        images: imageList.length ? imageList : [emptyImage("sticker")],
        enableGlobally: Boolean(enabledGlobally),
    };
};

const StickersPackEditorDialog: React.FC<IProps> = ({ room, event, enabledGlobally, onFinished }) => {
    const [editingPack, setEditingPack] = useState<EditablePack>(() => buildPackFromEvent(room, event, enabledGlobally));
    const [activeUsage, setActiveUsage] = useState<"sticker" | "emoticon">("sticker");
    const [isSaving, setIsSaving] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
    const avatarUploadRef = useRef<HTMLInputElement | null>(null);
    const uploadInputRef = useRef<HTMLInputElement | null>(null);
    const importInputRef = useRef<HTMLInputElement | null>(null);

    const updateEditingPack = (patch: Partial<EditablePack>): void => {
        setEditingPack((current) => ({ ...current, ...patch }));
    };

    const updateImage = (index: number, patch: Partial<EditableImage>): void => {
        setEditingPack((current) => {
            const nextImages = [...current.images];
            nextImages[index] = { ...nextImages[index], ...patch };
            return { ...current, images: nextImages };
        });
    };

    const removeImage = (index: number): void => {
        setEditingPack((current) => {
            const nextImages = current.images.filter((_, i) => i !== index);
            return { ...current, images: nextImages.length ? nextImages : [emptyImage(activeUsage)] };
        });
    };

    const toggleImageUsage = (index: number): void => {
        updateImage(index, {
            usageSticker: activeUsage === "emoticon",
            usageEmoticon: activeUsage === "sticker",
        });
    };

    const setGlobalEnabled = async (stateKey: string, enabled: boolean): Promise<void> => {
        const client = room.client;
        const content = client.getAccountData(EMOTE_ROOMS_EVENT_TYPE)?.getContent() ?? {};
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

    const handleUploadFiles = async (files: FileList | null): Promise<void> => {
        if (!files) return;
        setIsUploading(true);
        try {
            const existingKeys = new Set(editingPack.images.map((image) => image.key));
            const nextImages = [...editingPack.images];
            for (const file of Array.from(files)) {
                const { content_uri: url } = await room.client.uploadContent(file);
                const desiredKey = normalizeKey(file.name);
                const key = nextUniqueKey(desiredKey || "image", existingKeys);
                existingKeys.add(key);
                nextImages.push({
                    key,
                    url,
                    body: key,
                    usageSticker: activeUsage === "sticker",
                    usageEmoticon: activeUsage === "emoticon",
                });
            }
            setEditingPack((current) => ({ ...current, images: nextImages }));
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|upload_error_title"),
                description: _t("room_settings|stickers|upload_error_description"),
            });
        } finally {
            setIsUploading(false);
            if (uploadInputRef.current) uploadInputRef.current.value = "";
        }
    };

    const handleImportArchive = async (file: File | null): Promise<void> => {
        if (!file) return;
        setIsUploading(true);
        setImportProgress(null);
        try {
            const buffer = new Uint8Array(await file.arrayBuffer());
            const tarBytes = pako.ungzip(buffer);
            const entries = parseTar(tarBytes);
            const existingKeys = new Set(editingPack.images.map((image) => image.key));
            const nextImages = [...editingPack.images];
            setImportProgress({ current: 0, total: entries.length });

            for (const entry of entries) {
                const name = entry.name.split("/").pop() || "";
                if (!name) continue;
                const dot = name.lastIndexOf(".");
                const base = dot > 0 ? name.slice(0, dot) : name;
                const ext = dot > 0 ? name.slice(dot + 1) : "png";
                const keyBase = normalizeKey(base || "image");
                const key = nextUniqueKey(keyBase, existingKeys);
                existingKeys.add(key);

                const blob = new Blob([entry.data], { type: getMimeForExtension(ext) });
                const { content_uri: url } = await room.client.uploadContent(blob, { type: blob.type });
                nextImages.push({
                    key,
                    url,
                    body: key,
                    usageSticker: activeUsage === "sticker",
                    usageEmoticon: activeUsage === "emoticon",
                });
                setImportProgress((progress) =>
                    progress ? { ...progress, current: Math.min(progress.current + 1, progress.total) } : progress,
                );
            }

            setEditingPack((current) => ({ ...current, images: nextImages }));
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|import_error_title"),
                description: _t("room_settings|stickers|import_error_description"),
            });
        } finally {
            setIsUploading(false);
            setImportProgress(null);
            if (importInputRef.current) importInputRef.current.value = "";
        }
    };

    const saveEditingPack = async (): Promise<void> => {
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
            onFinished(true);
        } catch (error) {
            Modal.createDialog(ErrorDialog, {
                title: _t("room_settings|stickers|save_error_title"),
                description: _t("room_settings|stickers|save_error_description"),
            });
        } finally {
            setIsSaving(false);
        }
    };

    const title = editingPack.originalStateKey ? _t("room_settings|stickers|editor_title") : _t("room_settings|stickers|add_pack");

    return (
        <BaseDialog className="mx_StickersPackEditorDialog" onFinished={onFinished} title={title}>
            <div className="mx_StickersPackEditorDialog_content">
                <div className="mx_StickersRoomSettingsTab_editorFields">
                    <Field
                        label={_t("room_settings|stickers|state_key")}
                        value={editingPack.stateKey}
                        onChange={(ev) => updateEditingPack({ stateKey: (ev.target as HTMLInputElement).value })}
                    />
                    <Field
                        label={_t("room_settings|stickers|display_name")}
                        value={editingPack.displayName}
                        onChange={(ev) => updateEditingPack({ displayName: (ev.target as HTMLInputElement).value })}
                    />
                    <Field
                        label={_t("room_settings|stickers|attribution")}
                        value={editingPack.attribution}
                        onChange={(ev) => updateEditingPack({ attribution: (ev.target as HTMLInputElement).value })}
                    />
                    <div className="mx_StickersPackEditorDialog_avatarRow">
                        <div className="mx_StickersPackEditorDialog_avatarPreview">
                            {editingPack.avatarUrl ? (
                                <img
                                    src={mediaFromMxc(editingPack.avatarUrl).getSquareThumbnailHttp(64) ?? undefined}
                                    alt=""
                                />
                            ) : (
                                <div className="mx_StickersPackEditorDialog_avatarPlaceholder">
                                    {_t("room_settings|stickers|avatar_placeholder")}
                                </div>
                            )}
                        </div>
                        <input
                            ref={avatarUploadRef}
                            type="file"
                            accept="image/*"
                            className="mx_StickersRoomSettingsTab_uploadInput"
                            onChange={async (ev) => {
                                const file = ev.target.files?.[0];
                                if (!file) return;
                                setIsUploading(true);
                                try {
                                    const { content_uri: url } = await room.client.uploadContent(file);
                                    updateEditingPack({ avatarUrl: url });
                                } catch (error) {
                                    Modal.createDialog(ErrorDialog, {
                                        title: _t("room_settings|stickers|upload_error_title"),
                                        description: _t("room_settings|stickers|upload_error_description"),
                                    });
                                } finally {
                                    setIsUploading(false);
                                    if (avatarUploadRef.current) avatarUploadRef.current.value = "";
                                }
                            }}
                        />
                        <AccessibleButton
                            kind="secondary"
                            disabled={isUploading}
                            onClick={() => avatarUploadRef.current?.click()}
                        >
                            {_t("room_settings|stickers|upload_avatar")}
                        </AccessibleButton>
                    </div>
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
                    <div className="mx_StickersRoomSettingsTab_usageTabs">
                        <AccessibleButton
                            kind={activeUsage === "sticker" ? "primary_outline" : "secondary"}
                            onClick={() => setActiveUsage("sticker")}
                        >
                            {_t("room_settings|stickers|tab_stickers")}
                        </AccessibleButton>
                        <AccessibleButton
                            kind={activeUsage === "emoticon" ? "primary_outline" : "secondary"}
                            onClick={() => setActiveUsage("emoticon")}
                        >
                            {_t("room_settings|stickers|tab_emoticons")}
                        </AccessibleButton>
                    </div>
                    <div className="mx_StickersRoomSettingsTab_cards">
                        {editingPack.images.map((image, index) => {
                            const visible = activeUsage === "sticker" ? image.usageSticker : image.usageEmoticon;
                            if (!visible) return null;
                            return (
                                <div className="mx_StickersRoomSettingsTab_card" key={`image_${index}`}>
                                    <div className="mx_StickersRoomSettingsTab_cardImage">
                                        {image.url ? (
                                            <img
                                                src={
                                                    mediaFromMxc(image.url).getThumbnailOfSourceHttp(220, 220, "scale") ??
                                                    undefined
                                                }
                                                alt={image.body || image.key}
                                            />
                                        ) : (
                                            <div className="mx_StickersRoomSettingsTab_cardPlaceholder">
                                                {_t("room_settings|stickers|image_placeholder")}
                                            </div>
                                        )}
                                    </div>
                                    <div className="mx_StickersRoomSettingsTab_cardFields">
                                        <Field
                                            label={_t("room_settings|stickers|image_key")}
                                            value={image.key}
                                            onChange={(ev) =>
                                                updateImage(index, {
                                                    key: (ev.target as HTMLInputElement).value,
                                                })
                                            }
                                        />
                                        <Field
                                            label={_t("room_settings|stickers|image_body")}
                                            value={image.body}
                                            onChange={(ev) =>
                                                updateImage(index, {
                                                    body: (ev.target as HTMLInputElement).value,
                                                })
                                            }
                                        />
                                    </div>
                                    <div className="mx_StickersRoomSettingsTab_cardActions">
                                        <AccessibleButton kind="secondary" onClick={() => toggleImageUsage(index)}>
                                            {activeUsage === "sticker"
                                                ? _t("room_settings|stickers|move_to_emoticons")
                                                : _t("room_settings|stickers|move_to_stickers")}
                                        </AccessibleButton>
                                        <AccessibleButton kind="danger_inline" onClick={() => removeImage(index)}>
                                            {_t("action|remove")}
                                        </AccessibleButton>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="mx_StickersRoomSettingsTab_uploadRow">
                        <input
                            ref={uploadInputRef}
                            type="file"
                            accept="image/*"
                            multiple
                            className="mx_StickersRoomSettingsTab_uploadInput"
                            onChange={(ev) => void handleUploadFiles(ev.target.files)}
                        />
                        <input
                            ref={importInputRef}
                            type="file"
                            accept=".tar.gz"
                            className="mx_StickersRoomSettingsTab_uploadInput"
                            onChange={(ev) => void handleImportArchive(ev.target.files?.[0] ?? null)}
                        />
                        <AccessibleButton
                            kind="primary"
                            disabled={isUploading}
                            onClick={() => uploadInputRef.current?.click()}
                        >
                            {_t("room_settings|stickers|upload_images")}
                        </AccessibleButton>
                        <AccessibleButton
                            kind="secondary"
                            disabled={isUploading}
                            onClick={() => importInputRef.current?.click()}
                        >
                            {_t("room_settings|stickers|import_pack")}
                        </AccessibleButton>
                        {importProgress && (
                            <div className="mx_StickersPackEditorDialog_importProgress">
                                {_t("room_settings|stickers|import_progress", {
                                    current: importProgress.current,
                                    total: importProgress.total,
                                })}
                            </div>
                        )}
                    </div>
                </div>
                <div className="mx_StickersRoomSettingsTab_editorActions">
                    <AccessibleButton kind="primary" disabled={isSaving} onClick={saveEditingPack}>
                        {_t("action|save")}
                    </AccessibleButton>
                    <AccessibleButton kind="secondary" disabled={isSaving} onClick={() => onFinished(false)}>
                        {_t("action|cancel")}
                    </AccessibleButton>
                </div>
            </div>
        </BaseDialog>
    );
};

export default StickersPackEditorDialog;
