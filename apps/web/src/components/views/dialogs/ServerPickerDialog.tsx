/*
Copyright 2024 New Vector Ltd.
Copyright 2020, 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEvent, createRef, type SyntheticEvent } from "react";
import { AutoDiscovery } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import AutoDiscoveryUtils from "../../../utils/AutoDiscoveryUtils";
import BaseDialog from "./BaseDialog";
import { _t, UserFriendlyError } from "../../../languageHandler";
import AccessibleButton from "../elements/AccessibleButton";
import SdkConfig from "../../../SdkConfig";
import { type IConfigHomeserverOption, type IServerConfigSource } from "../../../IConfigOptions";
import Field from "../elements/Field";
import StyledRadioButton from "../elements/StyledRadioButton";
import TextWithTooltip from "../elements/TextWithTooltip";
import withValidation, { type IFieldState, type IValidationResult } from "../elements/Validation";
import { type ValidatedServerConfig } from "../../../utils/ValidatedServerConfig";
import ExternalLink from "../elements/ExternalLink";

interface IProps {
    title?: string;
    serverConfig: ValidatedServerConfig;
    onFinished(config?: ValidatedServerConfig): void;
}

type ServerType = "default" | "preset" | "custom";

interface IState {
    selectedType: ServerType;
    selectedPreset?: string;
    otherHomeserver: string;
}

export default class ServerPickerDialog extends React.PureComponent<IProps, IState> {
    private readonly defaultServer: ValidatedServerConfig;
    private readonly homeserverOptions: IConfigHomeserverOption[];
    private readonly disableCustomUrls: boolean;
    private readonly fieldRef = createRef<Field>();
    private validatedConf?: ValidatedServerConfig;

    public constructor(props: IProps) {
        super(props);

        const config = SdkConfig.get();
        this.defaultServer = config["validated_server_config"]!;
        this.homeserverOptions = config["homeserver_options"] ?? [];
        this.disableCustomUrls = !!config["disable_custom_urls"];

        const { serverConfig } = this.props;

        let selectedType: ServerType = "default";
        let selectedPreset: string | undefined;
        let otherHomeserver = "";

        if (!serverConfig.isDefault) {
            selectedPreset = this.findMatchingPreset(serverConfig);
            if (selectedPreset) {
                selectedType = "preset";
            } else {
                selectedType = this.disableCustomUrls ? "default" : "custom";
                if (!this.disableCustomUrls) {
                    if (serverConfig.isNameResolvable && serverConfig.hsName) {
                        otherHomeserver = serverConfig.hsName;
                    } else {
                        otherHomeserver = serverConfig.hsUrl;
                    }
                }
            }
        }

        this.state = {
            selectedType,
            selectedPreset,
            otherHomeserver,
        };
    }

    private normaliseServerInput = (server: string): string => {
        const trimmed = server.trim().toLowerCase();
        if (!trimmed) return "";
        if (!trimmed.includes("://")) {
            return trimmed.replace(/\/+$/, "");
        }

        try {
            const parsed = new URL(trimmed);
            return `${parsed.protocol}//${parsed.host}`;
        } catch {
            return trimmed.replace(/\/+$/, "");
        }
    };

    private getKnownServerIdentifiers = (config: ValidatedServerConfig): string[] => {
        const identifiers = [config.hsName, config.hsUrl]
            .filter((value): value is string => !!value)
            .map(this.normaliseServerInput);
        return Array.from(new Set(identifiers));
    };

    private getPresetValue = (index: number): string => {
        return index.toString();
    };

    private getPresetByValue = (value: string): IConfigHomeserverOption | undefined => {
        const index = Number.parseInt(value, 10);
        if (Number.isNaN(index)) {
            return undefined;
        }

        return this.homeserverOptions[index];
    };

    private getServerConfigSourceFromLegacyServer = (server: string): IServerConfigSource => {
        const trimmedServer = server.trim();
        if (trimmedServer.includes("://")) {
            return {
                default_hs_url: trimmedServer,
            };
        }

        return {
            default_server_name: trimmedServer,
        };
    };

    private getPresetServerConfigSource = (option: IConfigHomeserverOption): IServerConfigSource | undefined => {
        if (option.default_server_config || option.default_server_name || option.default_hs_url) {
            return {
                default_server_config: option.default_server_config,
                default_server_name: option.default_server_name,
                default_hs_url: option.default_hs_url,
                default_is_url: option.default_is_url,
            };
        }

        if (option.server) {
            return this.getServerConfigSourceFromLegacyServer(option.server);
        }

        return undefined;
    };

    private getPresetIdentifiers = (option: IConfigHomeserverOption): string[] => {
        const source = this.getPresetServerConfigSource(option);
        const identifiers = [
            option.server,
            source?.default_server_name,
            source?.default_hs_url,
            source?.default_server_config?.["m.homeserver"]?.base_url,
        ]
            .filter((value): value is string => !!value)
            .map(this.normaliseServerInput);

        return Array.from(new Set(identifiers));
    };

    private findMatchingPreset = (serverConfig: ValidatedServerConfig): string | undefined => {
        const identifiers = this.getKnownServerIdentifiers(serverConfig);
        if (!identifiers.length) {
            return undefined;
        }

        for (const [index, option] of this.homeserverOptions.entries()) {
            const optionIdentifiers = this.getPresetIdentifiers(option);
            if (optionIdentifiers.some((identifier) => identifiers.includes(identifier))) {
                return this.getPresetValue(index);
            }
        }

        return undefined;
    };

    private validatePresetAndSubmit = async (preset: IConfigHomeserverOption): Promise<void> => {
        const source = this.getPresetServerConfigSource(preset);
        if (!source) {
            return;
        }

        try {
            this.validatedConf = await AutoDiscoveryUtils.validateServerConfigSource(source);
            this.props.onFinished(this.validatedConf);
        } catch (e) {
            logger.error(e);
        }
    };

    private onDefaultChosen = (): void => {
        this.setState({ selectedType: "default" });
    };

    private onPresetChosen = (ev: ChangeEvent<HTMLInputElement>): void => {
        this.setState({ selectedType: "preset", selectedPreset: ev.target.value });
    };

    private onOtherChosen = (): void => {
        this.setState({ selectedType: "custom" });
    };

    private onHomeserverChange = (ev: ChangeEvent<HTMLInputElement>): void => {
        this.setState({ otherHomeserver: ev.target.value });
    };

    private validate = withValidation<this, { error?: string }>({
        deriveData: async ({ value }): Promise<{ error?: string }> => {
            let hsUrl = (value ?? "").trim(); // trim to account for random whitespace

            // if the URL has no protocol, try validate it as a serverName via well-known
            if (!hsUrl.includes("://")) {
                try {
                    const discoveryResult = await AutoDiscovery.findClientConfig(hsUrl);
                    this.validatedConf = await AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(
                        hsUrl,
                        discoveryResult,
                    );
                    return {}; // we have a validated config, we don't need to try the other paths
                } catch (e) {
                    logger.error(`Attempted ${hsUrl} as a server_name but it failed`, e);
                }
            }

            // if we got to this stage then either the well-known failed or the URL had a protocol specified,
            // so validate statically only. If the URL has no protocol, default to https.
            if (!hsUrl.includes("://")) {
                hsUrl = "https://" + hsUrl;
            }

            try {
                this.validatedConf = await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(hsUrl);
                return {};
            } catch (e) {
                logger.error(e);

                const stateForError = AutoDiscoveryUtils.authComponentStateForError(e);
                if (stateForError.serverErrorIsFatal) {
                    let error = _t("auth|server_picker_failed_validate_homeserver");
                    if (e instanceof UserFriendlyError && e.translatedMessage) {
                        error = e.translatedMessage;
                    }
                    return { error };
                }

                // try to carry on anyway
                try {
                    this.validatedConf = await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(
                        hsUrl,
                        undefined,
                        true,
                    );
                    return {};
                } catch (e) {
                    logger.error(e);
                    return { error: _t("auth|server_picker_invalid_url") };
                }
            }
        },
        rules: [
            {
                key: "required",
                test: ({ value, allowEmpty }) => allowEmpty || !!value,
                invalid: () => _t("auth|server_picker_required"),
            },
            {
                key: "valid",
                test: async function ({ value }, { error }): Promise<boolean> {
                    if (!value) return true;
                    return !error;
                },
                invalid: function ({ error }) {
                    return error ?? null;
                },
            },
        ],
    });

    private onHomeserverValidate = (fieldState: IFieldState): Promise<IValidationResult> => this.validate(fieldState);

    private onSubmit = async (ev: SyntheticEvent): Promise<void> => {
        ev.preventDefault();

        if (this.state.selectedType === "default") {
            this.props.onFinished(this.defaultServer);
            return;
        }

        if (this.state.selectedType === "preset") {
            if (!this.state.selectedPreset) {
                return;
            }
            const selectedPreset = this.getPresetByValue(this.state.selectedPreset);
            if (!selectedPreset) {
                return;
            }
            await this.validatePresetAndSubmit(selectedPreset);
            return;
        }

        const valid = await this.fieldRef.current?.validate({ allowEmpty: false });

        if (!valid) {
            this.fieldRef.current?.focus();
            this.fieldRef.current?.validate({ allowEmpty: false, focused: true });
            return;
        }

        this.props.onFinished(this.validatedConf);
    };

    public render(): React.ReactNode {
        let text: string | undefined;
        if (this.defaultServer.hsName === "matrix.org") {
            text = _t("auth|server_picker_matrix.org");
        }

        let defaultServerName: React.ReactNode = this.defaultServer.hsName;
        if (this.defaultServer.hsNameIsDifferent) {
            defaultServerName = (
                <TextWithTooltip className="mx_Login_underlinedServerName" tooltip={this.defaultServer.hsUrl}>
                    {this.defaultServer.hsName}
                </TextWithTooltip>
            );
        }

        return (
            <BaseDialog
                title={this.props.title || _t("auth|server_picker_title")}
                className="mx_ServerPickerDialog"
                contentId="mx_ServerPickerDialog"
                onFinished={this.props.onFinished}
                fixedWidth={false}
                hasCancel={true}
            >
                <form className="mx_Dialog_content" id="mx_ServerPickerDialog" onSubmit={this.onSubmit}>
                    <p>
                        {_t("auth|server_picker_intro")} {text}
                    </p>

                    <StyledRadioButton
                        name="homeserverChoice"
                        value="default"
                        checked={this.state.selectedType === "default"}
                        onChange={this.onDefaultChosen}
                        data-testid="defaultHomeserver"
                    >
                        {defaultServerName}
                    </StyledRadioButton>

                    {this.homeserverOptions.map((option, index) => {
                        const testId = `presetHomeserver-${index}`;
                        const presetValue = this.getPresetValue(index);
                        return (
                            <StyledRadioButton
                                key={`${option.name}-${presetValue}`}
                                name="homeserverChoice"
                                value={presetValue}
                                className="mx_ServerPickerDialog_presetHomeserverRadio"
                                checked={
                                    this.state.selectedType === "preset" && this.state.selectedPreset === presetValue
                                }
                                onChange={this.onPresetChosen}
                                data-testid={testId}
                            >
                                {option.name}
                            </StyledRadioButton>
                        );
                    })}

                    {!this.disableCustomUrls && (
                        <StyledRadioButton
                            name="homeserverChoice"
                            value="custom"
                            className="mx_ServerPickerDialog_otherHomeserverRadio"
                            checked={this.state.selectedType === "custom"}
                            onChange={this.onOtherChosen}
                            childrenInLabel={false}
                            aria-label={_t("auth|server_picker_custom")}
                        >
                            <Field
                                type="text"
                                className="mx_ServerPickerDialog_otherHomeserver"
                                label={_t("auth|server_picker_custom")}
                                onChange={this.onHomeserverChange}
                                onFocus={this.onOtherChosen}
                                ref={this.fieldRef}
                                onValidate={this.onHomeserverValidate}
                                value={this.state.otherHomeserver}
                                validateOnChange={false}
                                validateOnFocus={false}
                                autoFocus={this.state.selectedType === "custom"}
                                id="mx_homeserverInput"
                            />
                        </StyledRadioButton>
                    )}
                    <p>{_t("auth|server_picker_explainer")}</p>

                    <AccessibleButton className="mx_ServerPickerDialog_continue" kind="primary" onClick={this.onSubmit}>
                        {_t("action|continue")}
                    </AccessibleButton>

                    <h2>{_t("action|learn_more")}</h2>
                    <ExternalLink
                        href="https://matrix.org/docs/matrix-concepts/elements-of-matrix/#homeserver"
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {_t("auth|server_picker_learn_more")}
                    </ExternalLink>
                </form>
            </BaseDialog>
        );
    }
}
