export type ChannelReplyMode = 'none' | 'mention' | 'all';
export type ChannelMode = 'queue' | 'steer';
export type ChannelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'auto';

export interface ChannelSettings {
  channelId: string;
  name?: string;
  kind?: 'forum' | 'post' | 'channel';
  parentChannelId?: string;
  authorized: boolean;
  tracked: boolean;
  raw: {
    tracked: boolean | null;
    botReply: boolean | null;
    hindsightWrite: boolean | null;
    replyMode: ChannelReplyMode | null;
    mode: ChannelMode | null;
    model: string | null;
    effort: ChannelReasoningEffort | null;
    imageModel: string | null;
  };
  effective: {
    botReply: boolean;
    hindsightWrite: boolean;
    replyMode: ChannelReplyMode;
    mode: ChannelMode;
    model: string;
    effort: ChannelReasoningEffort;
    imageModel: string | null;
  };
}

export interface ChannelSettingsPatch {
  tracked?: boolean | null;
  botReply?: boolean | null;
  hindsightWrite?: boolean | null;
  replyMode?: ChannelReplyMode | null;
  mode?: ChannelMode | null;
  model?: string | null;
  effort?: ChannelReasoningEffort | null;
  imageModel?: string | null;
}

export interface ChannelManagement {
  listChannels(): Promise<ChannelSettings[]>;
  addChannel(id: string): Promise<ChannelSettings>;
  updateChannel(id: string, patch: ChannelSettingsPatch): Promise<ChannelSettings>;
  stopTracking(id: string): Promise<ChannelSettings>;
  models(): Promise<{ models: string[]; imageModels: string[] }>;
}
