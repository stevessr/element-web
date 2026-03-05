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

interface IConfigHomeserverOption {
    name: string;
    server: string;
}

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
        const identifiers = [config.hsName, config.hsUrl].filter(Boolean).map(this.normaliseServerInput);
        return Array.from(new Set(identifiers));
    };

    private findMatchingPreset = (serverConfig: ValidatedServerConfig): string | undefined => {
        const identifiers = this.getKnownServerIdentifiers(serverConfig);
        if (!identifiers.length) {
            return undefined;
        }

        for (const option of this.homeserverOptions) {
            const normalisedOption = this.normaliseServerInput(option.server);
            if (identifiers.includes(normalisedOption)) {
                return option.server;
            }
        }

        return undefined;
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

    private validateHomeserverAndSubmit = async (homeserver: string): Promise<void> => {
        const valid = await this.validate({ value: homeserver, focused: true, allowEmpty: false });

        if (!valid.valid) {
            if (this.state.selectedType === "custom") {
                this.fieldRef.current?.focus();
                this.fieldRef.current?.validate({ allowEmpty: false, focused: true });
            }
            return;
        }

        this.props.onFinished(this.validatedConf);
    };

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
            await this.validateHomeserverAndSubmit(this.state.selectedPreset);
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
                        return (
                            <StyledRadioButton
                                key={`${option.name}-${option.server}-${index}`}
                                name="homeserverChoice"
                                value={option.server}
                                className="mx_ServerPickerDialog_presetHomeserverRadio"
                                checked={
                                    this.state.selectedType === "preset" && this.state.selectedPreset === option.server
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
