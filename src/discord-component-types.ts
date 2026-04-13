import type { ChannelStructuredComponents } from "openclaw/plugin-sdk/channel-contract";

export type DiscordComponentEmoji = {
  name: string;
  id?: string;
  animated?: boolean;
};

export type DiscordComponentButtonStyle =
  | "primary"
  | "secondary"
  | "success"
  | "danger"
  | "link";

export type DiscordComponentSelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: DiscordComponentEmoji;
  default?: boolean;
};

export type DiscordComponentButtonSpec = {
  label: string;
  style?: DiscordComponentButtonStyle;
  url?: string;
  callbackData?: string;
  emoji?: DiscordComponentEmoji;
  disabled?: boolean;
  allowedUsers?: string[];
  internalCustomId?: string;
};

export type DiscordComponentSelectType =
  | "string"
  | "user"
  | "role"
  | "mentionable"
  | "channel";

export type DiscordComponentSelectSpec = {
  type?: DiscordComponentSelectType;
  callbackData?: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options?: DiscordComponentSelectOption[];
  allowedUsers?: string[];
};

export type DiscordComponentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "section";
      text?: string;
      texts?: string[];
      accessory?:
        | { type: "thumbnail"; url: string }
        | { type: "button"; button: DiscordComponentButtonSpec };
    }
  | {
      type: "separator";
      spacing?: "small" | "large" | 1 | 2;
      divider?: boolean;
    }
  | {
      type: "actions";
      buttons?: DiscordComponentButtonSpec[];
      select?: DiscordComponentSelectSpec;
    }
  | {
      type: "media-gallery";
      items: Array<{
        url: string;
        description?: string;
        spoiler?: boolean;
      }>;
    }
  | {
      type: "file";
      file: `attachment://${string}`;
      spoiler?: boolean;
    };

export type DiscordComponentModalFieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "select"
  | "role-select"
  | "user-select";

export type DiscordComponentModalField = {
  type: DiscordComponentModalFieldType;
  name?: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: string;
};

export type DiscordComponentMessageSpec = {
  text?: string;
  reusable?: boolean;
  container?: {
    accentColor?: unknown;
    spoiler?: boolean;
  };
  blocks?: DiscordComponentBlock[];
  modal?: {
    title: string;
    callbackData?: string;
    triggerLabel?: string;
    triggerStyle?: DiscordComponentButtonStyle;
    allowedUsers?: string[];
    fields: DiscordComponentModalField[];
  };
};

export type DiscordComponentEntry = {
  id: string;
  kind: "button" | "modal-trigger" | "select";
  label: string;
  callbackData?: string;
  modalId?: string;
  allowedUsers?: string[];
  selectType?: DiscordComponentSelectType;
  options?: Array<Pick<DiscordComponentSelectOption, "value" | "label">>;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
};

export type DiscordComponentModalRegistration = {
  id: string;
  title: string;
  callbackData?: string;
  fields: Array<DiscordComponentModalField & { name: string; id: string }>;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
  allowedUsers?: string[];
};

export type DiscordComponentBuildResult = {
  components: ChannelStructuredComponents;
  entries: DiscordComponentEntry[];
  modals: DiscordComponentModalRegistration[];
};
