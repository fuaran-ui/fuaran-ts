// GENERATED from idl.json by dev-scripts/generate-idl.mjs — DO NOT EDIT BY HAND.
//
// The structural vocabulary of the wire format, as data: what each kind, record,
// union case and op carries, how optional each member is, and the default an
// omitted member means. Regenerate with `node dev-scripts/generate-idl.mjs`;
// `--check` (and `packages/schema/test/generated.test.ts`) reports drift.
// Behaviour lives in the hand-written modules that read these tables.

import type { FieldRow, IdlType } from './idl.js';

/** SHA-256 of the exact `idl.json` bytes this module was generated from. */
export const IDL_SHA256 = '78d050701b82fe3475e0925f2d617689daa1ea786eda74084a8343ea9889b9cd';
export const IDL_VERSION = 1;

// ─── Types (each distinct IDL type once; nested types by name) ───────────────

const T_union_TextSource = {
  $type: 'union',
  name: 'TextSource',
  args: [],
} as const satisfies IdlType;
const T_enum_BadgeVariant = { $type: 'enum', name: 'BadgeVariant' } as const satisfies IdlType;
const T_node = { $type: 'node' } as const satisfies IdlType;
const T_list_node = { $type: 'list', of: T_node } as const satisfies IdlType;
const T_union_BoxLayout = {
  $type: 'union',
  name: 'BoxLayout',
  args: [],
} as const satisfies IdlType;
const T_enum_BoxRole = { $type: 'enum', name: 'BoxRole' } as const satisfies IdlType;
const T_bool = { $type: 'bool' } as const satisfies IdlType;
const T_union_Action = { $type: 'union', name: 'Action', args: [] } as const satisfies IdlType;
const T_enum_ButtonVariant = { $type: 'enum', name: 'ButtonVariant' } as const satisfies IdlType;
const T_str = { $type: 'str' } as const satisfies IdlType;
const T_fn = { $type: 'fn', wire: '<closure>' } as const satisfies IdlType;
const T_union_Binding_bool = {
  $type: 'union',
  name: 'Binding',
  args: [T_bool],
} as const satisfies IdlType;
const T_enum_ToneVariant = { $type: 'enum', name: 'ToneVariant' } as const satisfies IdlType;
const T_enum_ChartKind = { $type: 'enum', name: 'ChartKind' } as const satisfies IdlType;
const T_hosted = { $type: 'hosted', wire: 'json' } as const satisfies IdlType;
const T_union_Binding_hosted = {
  $type: 'union',
  name: 'Binding',
  args: [T_hosted],
} as const satisfies IdlType;
const T_list_str = { $type: 'list', of: T_str } as const satisfies IdlType;
const T_union_Format = { $type: 'union', name: 'Format', args: [] } as const satisfies IdlType;
const T_enum_ChartLegendPosition = {
  $type: 'enum',
  name: 'ChartLegendPosition',
} as const satisfies IdlType;
const T_enum_ChartDataLabels = {
  $type: 'enum',
  name: 'ChartDataLabels',
} as const satisfies IdlType;
const T_enum_ChartXScale = { $type: 'enum', name: 'ChartXScale' } as const satisfies IdlType;
const T_union_ChartAnnotation = {
  $type: 'union',
  name: 'ChartAnnotation',
  args: [],
} as const satisfies IdlType;
const T_list_union_ChartAnnotation = {
  $type: 'list',
  of: T_union_ChartAnnotation,
} as const satisfies IdlType;
const T_int = { $type: 'int' } as const satisfies IdlType;
const T_list_int = { $type: 'list', of: T_int } as const satisfies IdlType;
const T_json = { $type: 'json' } as const satisfies IdlType;
const T_map_json = { $type: 'map', values: T_json } as const satisfies IdlType;
const T_record_ContentHash = { $type: 'record', name: 'ContentHash' } as const satisfies IdlType;
const T_record_ColumnErased = { $type: 'record', name: 'ColumnErased' } as const satisfies IdlType;
const T_list_record_ColumnErased = {
  $type: 'list',
  of: T_record_ColumnErased,
} as const satisfies IdlType;
const T_record_DefaultSort = { $type: 'record', name: 'DefaultSort' } as const satisfies IdlType;
const T_union_Binding_int = {
  $type: 'union',
  name: 'Binding',
  args: [T_int],
} as const satisfies IdlType;
const T_record_StaticRows = { $type: 'record', name: 'StaticRows' } as const satisfies IdlType;
const T_union_Shape = { $type: 'union', name: 'Shape', args: [] } as const satisfies IdlType;
const T_list_union_Shape = { $type: 'list', of: T_union_Shape } as const satisfies IdlType;
const T_record_DrawStyle = { $type: 'record', name: 'DrawStyle' } as const satisfies IdlType;
const T_record_ViewBox = { $type: 'record', name: 'ViewBox' } as const satisfies IdlType;
const T_enum_ImageAspect = { $type: 'enum', name: 'ImageAspect' } as const satisfies IdlType;
const T_enum_EmbedPermission = {
  $type: 'enum',
  name: 'EmbedPermission',
} as const satisfies IdlType;
const T_list_enum_EmbedPermission = {
  $type: 'list',
  of: T_enum_EmbedPermission,
} as const satisfies IdlType;
const T_union_Binding_str = {
  $type: 'union',
  name: 'Binding',
  args: [T_str],
} as const satisfies IdlType;
const T_enum_CaptureSource = { $type: 'enum', name: 'CaptureSource' } as const satisfies IdlType;
const T_record_FilterSpec = { $type: 'record', name: 'FilterSpec' } as const satisfies IdlType;
const T_list_record_FilterSpec = {
  $type: 'list',
  of: T_record_FilterSpec,
} as const satisfies IdlType;
const T_record_FormField = { $type: 'record', name: 'FormField' } as const satisfies IdlType;
const T_list_record_FormField = {
  $type: 'list',
  of: T_record_FormField,
} as const satisfies IdlType;
const T_union_HoleDecl = { $type: 'union', name: 'HoleDecl', args: [] } as const satisfies IdlType;
const T_list_union_HoleDecl = { $type: 'list', of: T_union_HoleDecl } as const satisfies IdlType;
const T_record_EffectClass = { $type: 'record', name: 'EffectClass' } as const satisfies IdlType;
const T_union_FragmentArg = {
  $type: 'union',
  name: 'FragmentArg',
  args: [],
} as const satisfies IdlType;
const T_map_union_FragmentArg = {
  $type: 'map',
  values: T_union_FragmentArg,
} as const satisfies IdlType;
const T_enum_HeadingVariant = { $type: 'enum', name: 'HeadingVariant' } as const satisfies IdlType;
const T_enum_IconSize = { $type: 'enum', name: 'IconSize' } as const satisfies IdlType;
const T_enum_ImageVariant = { $type: 'enum', name: 'ImageVariant' } as const satisfies IdlType;
const T_enum_ImageFit = { $type: 'enum', name: 'ImageFit' } as const satisfies IdlType;
const T_enum_ImageLoading = { $type: 'enum', name: 'ImageLoading' } as const satisfies IdlType;
const T_record_SrcSetEntry = { $type: 'record', name: 'SrcSetEntry' } as const satisfies IdlType;
const T_list_record_SrcSetEntry = {
  $type: 'list',
  of: T_record_SrcSetEntry,
} as const satisfies IdlType;
const T_union_CellFormat = {
  $type: 'union',
  name: 'CellFormat',
  args: [],
} as const satisfies IdlType;
const T_float = { $type: 'float' } as const satisfies IdlType;
const T_union_Binding_float = {
  $type: 'union',
  name: 'Binding',
  args: [T_float],
} as const satisfies IdlType;
const T_enum_LinkProtection = { $type: 'enum', name: 'LinkProtection' } as const satisfies IdlType;
const T_list_union_TextSource = {
  $type: 'list',
  of: T_union_TextSource,
} as const satisfies IdlType;
const T_record_MapMarker = { $type: 'record', name: 'MapMarker' } as const satisfies IdlType;
const T_list_record_MapMarker = {
  $type: 'list',
  of: T_record_MapMarker,
} as const satisfies IdlType;
const T_union_Binding_list_record_MapMarker = {
  $type: 'union',
  name: 'Binding',
  args: [T_list_record_MapMarker],
} as const satisfies IdlType;
const T_enum_MathDisplay = { $type: 'enum', name: 'MathDisplay' } as const satisfies IdlType;
const T_union_MediaKind = {
  $type: 'union',
  name: 'MediaKind',
  args: [],
} as const satisfies IdlType;
const T_record_TrackEntry = { $type: 'record', name: 'TrackEntry' } as const satisfies IdlType;
const T_list_record_TrackEntry = {
  $type: 'list',
  of: T_record_TrackEntry,
} as const satisfies IdlType;
const T_enum_StyleWeight = { $type: 'enum', name: 'StyleWeight' } as const satisfies IdlType;
const T_enum_Emphasis = { $type: 'enum', name: 'Emphasis' } as const satisfies IdlType;
const T_enum_TrendPolarity = { $type: 'enum', name: 'TrendPolarity' } as const satisfies IdlType;
const T_enum_ModalityKind = { $type: 'enum', name: 'ModalityKind' } as const satisfies IdlType;
const T_record_GuestChannel = { $type: 'record', name: 'GuestChannel' } as const satisfies IdlType;
const T_enum_ScrollOrientation = {
  $type: 'enum',
  name: 'ScrollOrientation',
} as const satisfies IdlType;
const T_record_SelectOption = { $type: 'record', name: 'SelectOption' } as const satisfies IdlType;
const T_list_record_SelectOption = {
  $type: 'list',
  of: T_record_SelectOption,
} as const satisfies IdlType;
const T_union_Binding_list_record_SelectOption = {
  $type: 'union',
  name: 'Binding',
  args: [T_list_record_SelectOption],
} as const satisfies IdlType;
const T_union_Binding_list_str = {
  $type: 'union',
  name: 'Binding',
  args: [T_list_str],
} as const satisfies IdlType;
const T_list_float = { $type: 'list', of: T_float } as const satisfies IdlType;
const T_union_Binding_list_float = {
  $type: 'union',
  name: 'Binding',
  args: [T_list_float],
} as const satisfies IdlType;
const T_record_SwitchCase = { $type: 'record', name: 'SwitchCase' } as const satisfies IdlType;
const T_list_record_SwitchCase = {
  $type: 'list',
  of: T_record_SwitchCase,
} as const satisfies IdlType;
const T_enum_Orientation = { $type: 'enum', name: 'Orientation' } as const satisfies IdlType;
const T_record_TabHeader = { $type: 'record', name: 'TabHeader' } as const satisfies IdlType;
const T_list_record_TabHeader = {
  $type: 'list',
  of: T_record_TabHeader,
} as const satisfies IdlType;
const T_record_TreeItem = { $type: 'record', name: 'TreeItem' } as const satisfies IdlType;
const T_list_record_TreeItem = { $type: 'list', of: T_record_TreeItem } as const satisfies IdlType;
const T_enum_LiveRegionKind = { $type: 'enum', name: 'LiveRegionKind' } as const satisfies IdlType;
const T_union_CellKindErased = {
  $type: 'union',
  name: 'CellKindErased',
  args: [],
} as const satisfies IdlType;
const T_union_ColumnWidth = {
  $type: 'union',
  name: 'ColumnWidth',
  args: [],
} as const satisfies IdlType;
const T_union_Binding_json = {
  $type: 'union',
  name: 'Binding',
  args: [T_json],
} as const satisfies IdlType;
const T_enum_CompareOp = { $type: 'enum', name: 'CompareOp' } as const satisfies IdlType;
const T_enum_HashStrictness = { $type: 'enum', name: 'HashStrictness' } as const satisfies IdlType;
const T_enum_SortDirection = { $type: 'enum', name: 'SortDirection' } as const satisfies IdlType;
const T_enum_TextAnchor = { $type: 'enum', name: 'TextAnchor' } as const satisfies IdlType;
const T_enum_DeterminismSource = {
  $type: 'enum',
  name: 'DeterminismSource',
} as const satisfies IdlType;
const T_enum_HostEffect = { $type: 'enum', name: 'HostEffect' } as const satisfies IdlType;
const T_record_CompareRule = { $type: 'record', name: 'CompareRule' } as const satisfies IdlType;
const T_enum_TextFormat = { $type: 'enum', name: 'TextFormat' } as const satisfies IdlType;
const T_union_FormFieldKind = {
  $type: 'union',
  name: 'FormFieldKind',
  args: [],
} as const satisfies IdlType;
const T_record_FieldRule = { $type: 'record', name: 'FieldRule' } as const satisfies IdlType;
const T_enum_ChannelDirection = {
  $type: 'enum',
  name: 'ChannelDirection',
} as const satisfies IdlType;
const T_enum_TextDirection = { $type: 'enum', name: 'TextDirection' } as const satisfies IdlType;
const T_enum_StyleRole = { $type: 'enum', name: 'StyleRole' } as const satisfies IdlType;
const T_enum_FontVoice = { $type: 'enum', name: 'FontVoice' } as const satisfies IdlType;
const T_list_list_union_TextSource = {
  $type: 'list',
  of: T_list_union_TextSource,
} as const satisfies IdlType;
const T_enum_TrackKind = { $type: 'enum', name: 'TrackKind' } as const satisfies IdlType;
const T_list_union_Action = { $type: 'list', of: T_union_Action } as const satisfies IdlType;
const T_record_InvokeArg = { $type: 'record', name: 'InvokeArg' } as const satisfies IdlType;
const T_list_record_InvokeArg = {
  $type: 'list',
  of: T_record_InvokeArg,
} as const satisfies IdlType;
const T_enum_FileReadEncoding = {
  $type: 'enum',
  name: 'FileReadEncoding',
} as const satisfies IdlType;
const T_union_CallResultTarget = {
  $type: 'union',
  name: 'CallResultTarget',
  args: [],
} as const satisfies IdlType;
const T_enum_NavigateTarget = { $type: 'enum', name: 'NavigateTarget' } as const satisfies IdlType;
const T_var_T = { $type: 'var', name: 'T' } as const satisfies IdlType;
const T_enum_TimeGrain = { $type: 'enum', name: 'TimeGrain' } as const satisfies IdlType;
const T_union_LocalFlushTrigger = {
  $type: 'union',
  name: 'LocalFlushTrigger',
  args: [],
} as const satisfies IdlType;
const T_union_Binding_var_T = {
  $type: 'union',
  name: 'Binding',
  args: [T_var_T],
} as const satisfies IdlType;
const T_union_LocaleSource = {
  $type: 'union',
  name: 'LocaleSource',
  args: [],
} as const satisfies IdlType;
const T_map_union_Binding_json = {
  $type: 'map',
  values: T_union_Binding_json,
} as const satisfies IdlType;
const T_list_hosted = { $type: 'list', of: T_hosted } as const satisfies IdlType;
const T_record_TransformParam = {
  $type: 'record',
  name: 'TransformParam',
} as const satisfies IdlType;
const T_list_record_TransformParam = {
  $type: 'list',
  of: T_record_TransformParam,
} as const satisfies IdlType;
const T_enum_DurationUnit = { $type: 'enum', name: 'DurationUnit' } as const satisfies IdlType;
const T_enum_DurationStyle = { $type: 'enum', name: 'DurationStyle' } as const satisfies IdlType;
const T_enum_RelativeTimeUnit = {
  $type: 'enum',
  name: 'RelativeTimeUnit',
} as const satisfies IdlType;
const T_record_ButtonGroupItem = {
  $type: 'record',
  name: 'ButtonGroupItem',
} as const satisfies IdlType;
const T_list_record_ButtonGroupItem = {
  $type: 'list',
  of: T_record_ButtonGroupItem,
} as const satisfies IdlType;
const T_map_enum_ToneVariant = {
  $type: 'map',
  values: T_enum_ToneVariant,
} as const satisfies IdlType;
const T_union_ChartAnnotationX = {
  $type: 'union',
  name: 'ChartAnnotationX',
  args: [],
} as const satisfies IdlType;
const T_union_ChartAnnotationRange = {
  $type: 'union',
  name: 'ChartAnnotationRange',
  args: [],
} as const satisfies IdlType;
const T_record_DrawPoint = { $type: 'record', name: 'DrawPoint' } as const satisfies IdlType;
const T_enum_DateTimeVariant = {
  $type: 'enum',
  name: 'DateTimeVariant',
} as const satisfies IdlType;
const T_enum_DateStyle = { $type: 'enum', name: 'DateStyle' } as const satisfies IdlType;
const T_enum_TimeStyle = { $type: 'enum', name: 'TimeStyle' } as const satisfies IdlType;
const T_union_HoleValueSpace = {
  $type: 'union',
  name: 'HoleValueSpace',
  args: [],
} as const satisfies IdlType;
const T_union_Scalar = { $type: 'union', name: 'Scalar', args: [] } as const satisfies IdlType;
const T_list_record_DrawPoint = {
  $type: 'list',
  of: T_record_DrawPoint,
} as const satisfies IdlType;
const T_union_CurveCommand = {
  $type: 'union',
  name: 'CurveCommand',
  args: [],
} as const satisfies IdlType;
const T_list_union_CurveCommand = {
  $type: 'list',
  of: T_union_CurveCommand,
} as const satisfies IdlType;
const T_map_hosted = { $type: 'map', values: T_hosted } as const satisfies IdlType;
const T_op = { $type: 'op' } as const satisfies IdlType;
const T_list_op = { $type: 'list', of: T_op } as const satisfies IdlType;
const T_kind = { $type: 'kind' } as const satisfies IdlType;
const T_record_StyleDelta = { $type: 'record', name: 'StyleDelta' } as const satisfies IdlType;
const T_record_StateBehaviour = {
  $type: 'record',
  name: 'StateBehaviour',
} as const satisfies IdlType;
const T_record_SemanticStyle = {
  $type: 'record',
  name: 'SemanticStyle',
} as const satisfies IdlType;
const T_record_Accessibility = {
  $type: 'record',
  name: 'Accessibility',
} as const satisfies IdlType;

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Every bare-string enum's cases, as the wire spells them, in IDL order. */
export const ENUM_CASES = {
  BadgeVariant: ['Neutral', 'Brand', 'Success', 'Warning', 'Critical', 'Info'],
  BoxRole: ['Dashboard', 'Card', 'Group', 'Separator'],
  ButtonVariant: ['Primary', 'Secondary', 'Tertiary', 'Destructive'],
  CaptureSource: ['Camera', 'Microphone'],
  ChannelDirection: ['OutOnly', 'TwoWay'],
  ChartDataLabels: ['Off', 'Ends'],
  ChartKind: ['Line', 'Bar', 'Area', 'Pie', 'Scatter', 'Heatmap'],
  ChartLegendPosition: ['Top', 'Right', 'Bottom', 'None'],
  ChartXScale: ['Category', 'Temporal'],
  CompareOp: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'],
  DateStyle: ['Short', 'Medium', 'Long', 'Full'],
  DateTimeVariant: ['Date', 'Time', 'DateTime'],
  DeterminismSource: ['Deterministic', 'Clock', 'Random', 'Network'],
  DurationStyle: ['Compact', 'Clock', 'Long'],
  DurationUnit: ['Seconds', 'Minutes', 'Hours'],
  EmbedPermission: ['AllowScripts', 'AllowSameOrigin', 'AllowForms', 'AllowFullscreen'],
  Emphasis: ['Quiet', 'Normal', 'Loud'],
  FileReadEncoding: ['Text', 'Base64', 'DataUrl'],
  FontVoice: ['Default', 'Display', 'Structural'],
  HashStrictness: ['StrictReplay', 'AdvisoryWarning', 'Enforced'],
  HeadingVariant: ['Standard', 'Eyebrow', 'Caption', 'Lead'],
  HostEffect: ['Pure', 'ReadsHost', 'WritesHost'],
  IconSize: ['Small', 'Medium', 'Large'],
  ImageAspect: ['Natural', 'Square', 'FourThree', 'ThreeTwo', 'SixteenNine'],
  ImageFit: ['Natural', 'Cover', 'Contain'],
  ImageLoading: ['Eager', 'Lazy'],
  ImageVariant: ['Default', 'Avatar', 'Rounded'],
  LinkProtection: ['email'],
  LiveRegionKind: ['polite', 'assertive', 'off'],
  MathDisplay: ['Inline', 'Block'],
  ModalityKind: ['Modal', 'Popover'],
  Motion: [
    'None',
    'PulseDuringLoad',
    'FadeInOnMount',
    'SlideInFromBelow',
    'ShakeOnError',
    'RotateOnRefresh',
    'SlideInFromRight',
    'ExpandCollapse',
    'CrossFade',
    'SlideBetween',
  ],
  NavigateTarget: ['Self', 'Blank'],
  Orientation: ['Vertical', 'Horizontal'],
  RelativeTimeUnit: ['Second', 'Minute', 'Hour', 'Day', 'Week', 'Month', 'Year'],
  ScrollOrientation: ['Vertical', 'Horizontal', 'Both'],
  SortDirection: ['asc', 'desc'],
  StyleRole: ['None', 'Eyebrow', 'Data', 'Lede', 'Caption'],
  StyleWeight: ['Compact', 'Standard', 'Spacious'],
  TextAnchor: ['Start', 'Middle', 'End'],
  TextDirection: ['auto', 'ltr', 'rtl'],
  TextFormat: ['email', 'url', 'tel'],
  TimeGrain: ['Second', 'Minute', 'Hour', 'Day'],
  TimeStyle: ['Short', 'Medium', 'Long', 'Full'],
  ToneVariant: ['Default', 'Subdued', 'Brand', 'Success', 'Warning', 'Critical', 'Info'],
  TrackKind: ['Subtitles', 'Captions', 'Descriptions', 'Chapters'],
  TrendPolarity: ['HigherIsBetter', 'LowerIsBetter'],
} as const satisfies Record<string, readonly string[]>;
export type EnumName = keyof typeof ENUM_CASES;
/** The TypeScript union of an enum's cases. */
export type EnumCase<N extends EnumName> = (typeof ENUM_CASES)[N][number];

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** The emittable NodeKind vocabulary — every wire `kind.$type` name, in IDL order. */
export const NODE_KINDS = [
  'Badge',
  'Box',
  'Button',
  'Callout',
  'Chart',
  'CodeBlock',
  'Custom',
  'DataGrid',
  'Disclosure',
  'Drawing',
  'Embed',
  'ErrorBoundary',
  'Fact',
  'FileUpload',
  'Filters',
  'Form',
  'FragmentDecl',
  'FragmentRef',
  'Heading',
  'Icon',
  'Image',
  'LabelValueRow',
  'Link',
  'List',
  'Map',
  'Markdown',
  'Math',
  'Media',
  'Metric',
  'Modal',
  'Mount',
  'Progress',
  'ScrollArea',
  'Select',
  'Skeleton',
  'Sparkline',
  'SplitPanel',
  'Stepper',
  'SummaryList',
  'Switch',
  'Tabs',
  'Toast',
  'Tree',
] as const;
export type NodeKindName = (typeof NODE_KINDS)[number];
export const KIND_CATEGORIES = ['Display', 'Layout', 'Input', 'Visualisation', 'Meta'] as const;
export type KindCategory = (typeof KIND_CATEGORIES)[number];
export const KIND_CATEGORY = {
  Badge: 'Display',
  Box: 'Layout',
  Button: 'Input',
  Callout: 'Display',
  Chart: 'Visualisation',
  CodeBlock: 'Display',
  Custom: 'Meta',
  DataGrid: 'Visualisation',
  Disclosure: 'Layout',
  Drawing: 'Display',
  Embed: 'Display',
  ErrorBoundary: 'Meta',
  Fact: 'Display',
  FileUpload: 'Input',
  Filters: 'Input',
  Form: 'Input',
  FragmentDecl: 'Meta',
  FragmentRef: 'Meta',
  Heading: 'Display',
  Icon: 'Display',
  Image: 'Display',
  LabelValueRow: 'Display',
  Link: 'Display',
  List: 'Display',
  Map: 'Visualisation',
  Markdown: 'Display',
  Math: 'Display',
  Media: 'Display',
  Metric: 'Display',
  Modal: 'Layout',
  Mount: 'Meta',
  Progress: 'Display',
  ScrollArea: 'Layout',
  Select: 'Input',
  Skeleton: 'Display',
  Sparkline: 'Display',
  SplitPanel: 'Layout',
  Stepper: 'Layout',
  SummaryList: 'Layout',
  Switch: 'Meta',
  Tabs: 'Layout',
  Toast: 'Display',
  Tree: 'Display',
} as const satisfies Record<NodeKindName, KindCategory>;
/** The kinds of each category, in IDL order. */
export const KINDS_BY_CATEGORY = {
  Display: [
    'Badge',
    'Callout',
    'CodeBlock',
    'Drawing',
    'Embed',
    'Fact',
    'Heading',
    'Icon',
    'Image',
    'LabelValueRow',
    'Link',
    'List',
    'Markdown',
    'Math',
    'Media',
    'Metric',
    'Progress',
    'Skeleton',
    'Sparkline',
    'Toast',
    'Tree',
  ],
  Layout: [
    'Box',
    'Disclosure',
    'Modal',
    'ScrollArea',
    'SplitPanel',
    'Stepper',
    'SummaryList',
    'Tabs',
  ],
  Input: ['Button', 'FileUpload', 'Filters', 'Form', 'Select'],
  Visualisation: ['Chart', 'DataGrid', 'Map'],
  Meta: ['Custom', 'ErrorBoundary', 'FragmentDecl', 'FragmentRef', 'Mount', 'Switch'],
} as const satisfies Record<KindCategory, readonly NodeKindName[]>;

/** Each kind's field table, in IDL order. */
export const KIND_FIELDS = {
  Badge: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'variant', opt: 'required', type: T_enum_BadgeVariant },
  ],
  Box: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'heading', opt: 'optional', type: T_union_TextSource },
    { name: 'layout', opt: 'required', type: T_union_BoxLayout },
    { name: 'role', opt: 'required', type: T_enum_BoxRole },
    {
      name: 'keepTogether',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    {
      name: 'breakBefore',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
  ],
  Button: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'onClick', opt: 'required', type: T_union_Action },
    { name: 'variant', opt: 'required', type: T_enum_ButtonVariant },
    { name: 'icon', opt: 'optional', type: T_str },
    { name: 'tooltip', opt: 'hostOnly', type: T_fn },
    { name: 'disabled', opt: 'optional', type: T_union_Binding_bool },
  ],
  Callout: [
    { name: 'body', opt: 'required', type: T_union_TextSource },
    {
      name: 'dismissable',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    { name: 'heading', opt: 'optional', type: T_union_TextSource },
    { name: 'icon', opt: 'optional', type: T_str },
  ],
  Chart: [
    { name: 'kind', opt: 'required', type: T_enum_ChartKind },
    { name: 'source', opt: 'required', type: T_union_Binding_hosted },
    { name: 'stacked', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'xField', opt: 'required', type: T_str },
    { name: 'yFields', opt: 'required', type: T_list_str },
    { name: 'title', opt: 'optional', type: T_union_TextSource },
    { name: 'valueFormat', opt: 'optional', type: T_union_Format },
    { name: 'xTitle', opt: 'optional', type: T_union_TextSource },
    { name: 'yTitle', opt: 'optional', type: T_union_TextSource },
    { name: 'subtitle', opt: 'optional', type: T_union_TextSource },
    { name: 'legendPosition', opt: 'optional', type: T_enum_ChartLegendPosition },
    { name: 'dataLabels', opt: 'optional', type: T_enum_ChartDataLabels },
    { name: 'xScale', opt: 'optional', type: T_enum_ChartXScale },
    { name: 'annotations', opt: 'optional', type: T_list_union_ChartAnnotation },
    { name: 'onPointClick', opt: 'optional', type: T_fn },
  ],
  CodeBlock: [
    { name: 'code', opt: 'required', type: T_str },
    { name: 'copyable', opt: 'required', type: T_bool },
    { name: 'highlightLines', opt: 'required', type: T_list_int },
    { name: 'language', opt: 'required', type: T_str },
    { name: 'lineNumbers', opt: 'required', type: T_bool },
  ],
  Custom: [
    { name: 'moduleId', opt: 'required', type: T_str },
    { name: 'componentId', opt: 'required', type: T_str },
    { name: 'props', opt: 'required', type: T_map_json },
    { name: 'contentHash', opt: 'optional', type: T_record_ContentHash },
    { name: 'exposedNodeIds', opt: 'optional', type: T_list_str },
  ],
  DataGrid: [
    { name: 'columns', opt: 'required', type: T_list_record_ColumnErased },
    { name: 'editable', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'rowKey', opt: 'optional', type: T_fn },
    { name: 'rowKeyField', opt: 'optional', type: T_str },
    { name: 'sortStateKey', opt: 'optional', type: T_str },
    { name: 'pageSize', opt: 'optional', type: T_int },
    { name: 'pageStateKey', opt: 'optional', type: T_str },
    { name: 'defaultSort', opt: 'optional', type: T_record_DefaultSort },
    { name: 'editStateKey', opt: 'optional', type: T_str },
    {
      name: 'reorderable',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    { name: 'transferInKey', opt: 'optional', type: T_str },
    { name: 'transferOutKey', opt: 'optional', type: T_str },
    {
      name: 'keepRowsTogether',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    {
      name: 'repeatHeader',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    { name: 'exportable', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'windowStateKey', opt: 'optional', type: T_str },
    { name: 'rowTotal', opt: 'optional', type: T_union_Binding_int },
    { name: 'source', opt: 'required', type: T_union_Binding_hosted },
    { name: 'staticRows', opt: 'optional', type: T_record_StaticRows },
    { name: 'onRowClick', opt: 'optional', type: T_fn },
  ],
  Disclosure: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'defaultOpen', opt: 'required', type: T_bool },
    { name: 'heading', opt: 'required', type: T_union_TextSource },
    { name: 'onToggle', opt: 'optional', type: T_fn },
    { name: 'open', opt: 'required', type: T_union_Binding_bool },
  ],
  Drawing: [
    { name: 'description', opt: 'optional', type: T_union_TextSource },
    { name: 'shapes', opt: 'required', type: T_list_union_Shape },
    { name: 'style', opt: 'required', type: T_record_DrawStyle },
    { name: 'title', opt: 'optional', type: T_union_TextSource },
    { name: 'viewBox', opt: 'required', type: T_record_ViewBox },
  ],
  Embed: [
    {
      name: 'aspectRatio',
      opt: 'omitDefault',
      type: T_enum_ImageAspect,
      dflt: { $type: 'enum', case: 'Natural' },
    },
    {
      name: 'permissions',
      opt: 'omitDefault',
      type: T_list_enum_EmbedPermission,
      dflt: { $type: 'list', items: [] },
    },
    { name: 'src', opt: 'required', type: T_union_Binding_str },
    { name: 'title', opt: 'required', type: T_union_TextSource },
  ],
  ErrorBoundary: [
    { name: 'child', opt: 'required', type: T_node },
    { name: 'fallback', opt: 'required', type: T_node },
  ],
  Fact: [
    { name: 'emphasis', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'help', opt: 'optional', type: T_union_TextSource },
    { name: 'icon', opt: 'optional', type: T_str },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    { name: 'value', opt: 'required', type: T_union_TextSource },
  ],
  FileUpload: [
    { name: 'accept', opt: 'required', type: T_list_str },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'multiple', opt: 'required', type: T_bool },
    { name: 'onSelect', opt: 'optional', type: T_fn },
    { name: 'disabled', opt: 'optional', type: T_union_Binding_bool },
    {
      name: 'acceptPaste',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    { name: 'dropTarget', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'capture', opt: 'optional', type: T_enum_CaptureSource },
    { name: 'destination', opt: 'optional', type: T_str },
    { name: 'maxBytes', opt: 'optional', type: T_int },
    { name: 'maxFiles', opt: 'optional', type: T_int },
  ],
  Filters: [{ name: 'items', opt: 'required', type: T_list_record_FilterSpec }],
  Form: [
    { name: 'fields', opt: 'required', type: T_list_record_FormField },
    { name: 'onSubmit', opt: 'required', type: T_union_Action },
    { name: 'submitLabel', opt: 'required', type: T_union_TextSource },
    { name: 'disabled', opt: 'optional', type: T_union_Binding_bool },
  ],
  FragmentDecl: [
    { name: 'body', opt: 'required', type: T_node },
    { name: 'name', opt: 'required', type: T_str },
    {
      name: 'holes',
      opt: 'omitDefault',
      type: T_list_union_HoleDecl,
      dflt: { $type: 'list', items: [] },
    },
    {
      name: 'effect',
      opt: 'omitDefault',
      type: T_record_EffectClass,
      dflt: {
        $type: 'record',
        fields: [
          { name: 'determinism', value: { $type: 'enum', case: 'Deterministic' } },
          { name: 'hostEffect', value: { $type: 'enum', case: 'Pure' } },
        ],
      },
    },
  ],
  FragmentRef: [
    { name: 'name', opt: 'required', type: T_str },
    { name: 'args', opt: 'optional', type: T_map_union_FragmentArg },
  ],
  Heading: [
    { name: 'level', opt: 'required', type: T_int },
    { name: 'text', opt: 'required', type: T_union_TextSource },
    { name: 'variant', opt: 'required', type: T_enum_HeadingVariant },
  ],
  Icon: [
    { name: 'icon', opt: 'required', type: T_str },
    {
      name: 'size',
      opt: 'omitDefault',
      type: T_enum_IconSize,
      dflt: { $type: 'enum', case: 'Medium' },
    },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    { name: 'label', opt: 'optional', type: T_str },
  ],
  Image: [
    { name: 'alt', opt: 'required', type: T_union_TextSource },
    { name: 'src', opt: 'required', type: T_union_Binding_str },
    { name: 'variant', opt: 'required', type: T_enum_ImageVariant },
    {
      name: 'fit',
      opt: 'omitDefault',
      type: T_enum_ImageFit,
      dflt: { $type: 'enum', case: 'Natural' },
    },
    {
      name: 'aspectRatio',
      opt: 'omitDefault',
      type: T_enum_ImageAspect,
      dflt: { $type: 'enum', case: 'Natural' },
    },
    {
      name: 'loading',
      opt: 'omitDefault',
      type: T_enum_ImageLoading,
      dflt: { $type: 'enum', case: 'Eager' },
    },
    {
      name: 'srcSet',
      opt: 'omitDefault',
      type: T_list_record_SrcSetEntry,
      dflt: { $type: 'list', items: [] },
    },
    { name: 'expandable', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'caption', opt: 'optional', type: T_union_TextSource },
  ],
  LabelValueRow: [
    { name: 'emphasis', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    {
      name: 'format',
      opt: 'omitDefault',
      type: T_union_CellFormat,
      dflt: { $type: 'union', tag: 'None', fields: [] },
    },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'value', opt: 'required', type: T_union_Binding_float },
    { name: 'help', opt: 'optional', type: T_union_TextSource },
  ],
  Link: [
    { name: 'href', opt: 'required', type: T_union_Binding_str },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'download', opt: 'required', type: T_bool },
    { name: 'rel', opt: 'optional', type: T_str },
    { name: 'target', opt: 'optional', type: T_str },
    { name: 'protection', opt: 'optional', type: T_enum_LinkProtection },
  ],
  List: [
    { name: 'items', opt: 'required', type: T_list_union_TextSource },
    { name: 'ordered', opt: 'required', type: T_bool },
  ],
  Map: [
    { name: 'centreLatitude', opt: 'required', type: T_float },
    { name: 'centreLongitude', opt: 'required', type: T_float },
    { name: 'source', opt: 'required', type: T_union_Binding_list_record_MapMarker },
    { name: 'zoom', opt: 'required', type: T_int },
    { name: 'onMarkerClick', opt: 'optional', type: T_fn },
  ],
  Markdown: [{ name: 'text', opt: 'required', type: T_union_TextSource }],
  Math: [
    { name: 'source', opt: 'required', type: T_str },
    { name: 'display', opt: 'required', type: T_enum_MathDisplay },
  ],
  Media: [
    { name: 'controls', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: true } },
    { name: 'kind', opt: 'required', type: T_union_MediaKind },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'loop', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'src', opt: 'required', type: T_union_Binding_str },
    {
      name: 'tracks',
      opt: 'omitDefault',
      type: T_list_record_TrackEntry,
      dflt: { $type: 'list', items: [] },
    },
    { name: 'transcript', opt: 'optional', type: T_union_TextSource },
  ],
  Metric: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'value', opt: 'required', type: T_union_Binding_float },
    {
      name: 'format',
      opt: 'omitDefault',
      type: T_union_CellFormat,
      dflt: { $type: 'union', tag: 'None', fields: [] },
    },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    {
      name: 'weight',
      opt: 'omitDefault',
      type: T_enum_StyleWeight,
      dflt: { $type: 'enum', case: 'Standard' },
    },
    {
      name: 'emphasis',
      opt: 'omitDefault',
      type: T_enum_Emphasis,
      dflt: { $type: 'enum', case: 'Normal' },
    },
    { name: 'trend', opt: 'optional', type: T_union_Binding_float },
    { name: 'trendFormat', opt: 'optional', type: T_union_CellFormat },
    {
      name: 'trendPolarity',
      opt: 'omitDefault',
      type: T_enum_TrendPolarity,
      dflt: { $type: 'enum', case: 'HigherIsBetter' },
    },
    { name: 'icon', opt: 'optional', type: T_str },
    { name: 'subtext', opt: 'optional', type: T_union_TextSource },
  ],
  Modal: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'dismissable', opt: 'required', type: T_bool },
    { name: 'onDismiss', opt: 'optional', type: T_union_Action },
    { name: 'open', opt: 'required', type: T_union_Binding_bool },
    { name: 'heading', opt: 'optional', type: T_union_TextSource },
    {
      name: 'modality',
      opt: 'omitDefault',
      type: T_enum_ModalityKind,
      dflt: { $type: 'enum', case: 'Modal' },
    },
    { name: 'anchor', opt: 'optional', type: T_str },
  ],
  Mount: [
    { name: 'capabilities', opt: 'required', type: T_list_str },
    { name: 'channel', opt: 'required', type: T_record_GuestChannel },
    { name: 'inputs', opt: 'optional', type: T_map_union_FragmentArg },
    { name: 'onBubble', opt: 'optional', type: T_fn },
    { name: 'scopeId', opt: 'required', type: T_str },
  ],
  Progress: [
    { name: 'fraction', opt: 'required', type: T_union_Binding_float },
    {
      name: 'indeterminate',
      opt: 'omitDefault',
      type: T_bool,
      dflt: { $type: 'bool', value: false },
    },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    { name: 'label', opt: 'optional', type: T_union_TextSource },
    { name: 'caveat', opt: 'optional', type: T_union_TextSource },
  ],
  ScrollArea: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'orientation', opt: 'required', type: T_enum_ScrollOrientation },
    { name: 'maxHeight', opt: 'optional', type: T_int },
    { name: 'maxWidth', opt: 'optional', type: T_int },
  ],
  Select: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'onChange', opt: 'optional', type: T_fn },
    { name: 'onChangeMulti', opt: 'optional', type: T_fn },
    { name: 'source', opt: 'required', type: T_union_Binding_list_record_SelectOption },
    { name: 'value', opt: 'required', type: T_union_Binding_str },
    { name: 'placeholder', opt: 'optional', type: T_union_TextSource },
    { name: 'disabled', opt: 'optional', type: T_union_Binding_bool },
    { name: 'multiple', opt: 'optional', type: T_bool },
    { name: 'values', opt: 'optional', type: T_union_Binding_list_str },
  ],
  Skeleton: [{ name: 'rows', opt: 'required', type: T_int }],
  Sparkline: [{ name: 'source', opt: 'required', type: T_union_Binding_list_float }],
  SplitPanel: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'weight', opt: 'required', type: T_float },
  ],
  Stepper: [
    { name: 'activeStep', opt: 'required', type: T_union_Binding_int },
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'onSelect', opt: 'optional', type: T_fn },
  ],
  SummaryList: [
    { name: 'children', opt: 'required', type: T_list_node },
    { name: 'heading', opt: 'optional', type: T_union_TextSource },
  ],
  Switch: [
    { name: 'autoAdvanceMs', opt: 'optional', type: T_int },
    { name: 'cases', opt: 'required', type: T_list_record_SwitchCase },
    { name: 'default', opt: 'required', type: T_node },
    { name: 'on', opt: 'optional', type: T_union_Binding_str },
    { name: 'stateKey', opt: 'optional', type: T_str },
  ],
  Tabs: [
    {
      name: 'activeIndex',
      opt: 'omitDefault',
      type: T_union_Binding_int,
      dflt: {
        $type: 'union',
        tag: 'Static',
        fields: [{ name: 'value', value: { $type: 'int', value: 0 } }],
      },
    },
    { name: 'children', opt: 'required', type: T_list_node },
    {
      name: 'orientation',
      opt: 'omitDefault',
      type: T_enum_Orientation,
      dflt: { $type: 'enum', case: 'Horizontal' },
    },
    { name: 'onSelect', opt: 'optional', type: T_fn },
    { name: 'onSelectTag', opt: 'optional', type: T_fn },
    { name: 'tabHeaders', opt: 'optional', type: T_list_record_TabHeader },
    { name: 'tabTags', opt: 'optional', type: T_list_str },
    { name: 'activeTag', opt: 'optional', type: T_union_Binding_str },
  ],
  Toast: [
    { name: 'dismissable', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: true } },
    { name: 'message', opt: 'required', type: T_union_TextSource },
    { name: 'open', opt: 'required', type: T_union_Binding_bool },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
  ],
  Tree: [
    { name: 'expandedStateKey', opt: 'optional', type: T_str },
    { name: 'items', opt: 'required', type: T_list_record_TreeItem },
    { name: 'onSelect', opt: 'optional', type: T_fn },
    { name: 'selectionStateKey', opt: 'optional', type: T_str },
  ],
} as const satisfies Record<NodeKindName, readonly FieldRow[]>;

// ─── The node envelope ───────────────────────────────────────────────────────

export const NODE_FIELDS = [
  { name: 'accessibility', opt: 'optional', type: T_record_Accessibility },
  { name: 'extraAttributes', opt: 'hostOnly', type: T_fn },
  { name: 'fallback', opt: 'optional', type: T_node },
  { name: 'motion', opt: 'hostOnly', type: T_fn },
  { name: 'state', opt: 'optional', type: T_record_StateBehaviour },
  { name: 'style', opt: 'optional', type: T_record_SemanticStyle },
  { name: 'tooltip', opt: 'optional', type: T_union_TextSource },
  { name: 'visible', opt: 'optional', type: T_union_Binding_bool },
] as const satisfies readonly FieldRow[];

// ─── Records ─────────────────────────────────────────────────────────────────

export const RECORD_FIELDS = {
  Accessibility: [
    { name: 'describedBy', opt: 'optional', type: T_str },
    { name: 'hidden', opt: 'optional', type: T_union_Binding_bool },
    { name: 'label', opt: 'optional', type: T_union_Binding_str },
    { name: 'labelledBy', opt: 'optional', type: T_str },
    { name: 'liveRegion', opt: 'optional', type: T_enum_LiveRegionKind },
    { name: 'role', opt: 'optional', type: T_hosted },
    { name: 'speak', opt: 'optional', type: T_union_TextSource },
  ],
  ButtonGroupItem: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'onClick', opt: 'optional', type: T_fn },
  ],
  ColumnErased: [
    { name: 'field', opt: 'optional', type: T_str },
    { name: 'sortable', opt: 'optional', type: T_bool },
    { name: 'editable', opt: 'optional', type: T_bool },
    {
      name: 'format',
      opt: 'omitDefault',
      type: T_union_CellFormat,
      dflt: { $type: 'union', tag: 'None', fields: [] },
    },
    { name: 'kind', opt: 'required', type: T_union_CellKindErased },
    { name: 'label', opt: 'required', type: T_str },
    { name: 'value', opt: 'optional', type: T_fn },
    {
      name: 'width',
      opt: 'omitDefault',
      type: T_union_ColumnWidth,
      dflt: { $type: 'union', tag: 'Auto', fields: [] },
    },
  ],
  CompareRule: [
    { name: 'against', opt: 'required', type: T_union_Binding_json },
    { name: 'op', opt: 'required', type: T_enum_CompareOp },
  ],
  ContentHash: [
    { name: 'algorithm', opt: 'required', type: T_str },
    { name: 'hash', opt: 'required', type: T_str },
    { name: 'strictness', opt: 'required', type: T_enum_HashStrictness },
  ],
  DateTimeRangePair: [
    { name: 'from', opt: 'required', type: T_str },
    { name: 'to', opt: 'required', type: T_str },
  ],
  DefaultSort: [
    { name: 'column', opt: 'required', type: T_int },
    { name: 'direction', opt: 'required', type: T_enum_SortDirection },
  ],
  DrawPoint: [
    { name: 'x', opt: 'required', type: T_float },
    { name: 'y', opt: 'required', type: T_float },
  ],
  DrawStyle: [
    { name: 'emphasis', opt: 'optional', type: T_enum_Emphasis },
    { name: 'fill', opt: 'optional', type: T_union_Binding_str },
    { name: 'fontFamily', opt: 'optional', type: T_str },
    { name: 'fontSize', opt: 'optional', type: T_float },
    { name: 'markId', opt: 'optional', type: T_str },
    { name: 'opacity', opt: 'optional', type: T_union_Binding_float },
    { name: 'rotation', opt: 'optional', type: T_float },
    { name: 'stroke', opt: 'optional', type: T_union_Binding_str },
    { name: 'strokeWidth', opt: 'optional', type: T_union_Binding_float },
    { name: 'textAnchor', opt: 'optional', type: T_enum_TextAnchor },
    { name: 'tip', opt: 'optional', type: T_union_TextSource },
  ],
  EffectClass: [
    { name: 'determinism', opt: 'required', type: T_enum_DeterminismSource },
    { name: 'hostEffect', opt: 'required', type: T_enum_HostEffect },
  ],
  FieldRule: [
    { name: 'compare', opt: 'optional', type: T_record_CompareRule },
    { name: 'format', opt: 'optional', type: T_enum_TextFormat },
    { name: 'maxLength', opt: 'optional', type: T_int },
    { name: 'message', opt: 'optional', type: T_union_TextSource },
    { name: 'minLength', opt: 'optional', type: T_int },
    { name: 'pattern', opt: 'optional', type: T_str },
  ],
  FilterSpec: [
    { name: 'kind', opt: 'required', type: T_union_FormFieldKind },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'name', opt: 'required', type: T_str },
  ],
  FormField: [
    { name: 'id', opt: 'required', type: T_str },
    { name: 'kind', opt: 'required', type: T_union_FormFieldKind },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'required', opt: 'required', type: T_bool },
    { name: 'help', opt: 'optional', type: T_union_TextSource },
    { name: 'rule', opt: 'optional', type: T_record_FieldRule },
  ],
  GuestChannel: [
    { name: 'direction', opt: 'required', type: T_enum_ChannelDirection },
    { name: 'messageShape', opt: 'optional', type: T_str },
  ],
  InvokeArg: [
    { name: 'addr', opt: 'required', type: T_str },
    { name: 'value', opt: 'required', type: T_str },
  ],
  MapMarker: [
    { name: 'label', opt: 'required', type: T_str },
    { name: 'latitude', opt: 'required', type: T_float },
    { name: 'longitude', opt: 'required', type: T_float },
  ],
  RangePair: [
    { name: 'max', opt: 'required', type: T_float },
    { name: 'min', opt: 'required', type: T_float },
  ],
  SelectOption: [
    { name: 'label', opt: 'required', type: T_str },
    { name: 'value', opt: 'required', type: T_str },
  ],
  SemanticStyle: [
    {
      name: 'direction',
      opt: 'omitDefault',
      type: T_enum_TextDirection,
      dflt: { $type: 'enum', case: 'auto' },
    },
    {
      name: 'emphasis',
      opt: 'omitDefault',
      type: T_enum_Emphasis,
      dflt: { $type: 'enum', case: 'Normal' },
    },
    {
      name: 'role',
      opt: 'omitDefault',
      type: T_enum_StyleRole,
      dflt: { $type: 'enum', case: 'None' },
    },
    {
      name: 'tone',
      opt: 'omitDefault',
      type: T_enum_ToneVariant,
      dflt: { $type: 'enum', case: 'Default' },
    },
    {
      name: 'voice',
      opt: 'omitDefault',
      type: T_enum_FontVoice,
      dflt: { $type: 'enum', case: 'Default' },
    },
    {
      name: 'weight',
      opt: 'omitDefault',
      type: T_enum_StyleWeight,
      dflt: { $type: 'enum', case: 'Standard' },
    },
  ],
  SrcSetEntry: [
    { name: 'src', opt: 'required', type: T_union_Binding_str },
    { name: 'width', opt: 'required', type: T_int },
  ],
  StateBehaviour: [
    { name: 'onEmpty', opt: 'optional', type: T_node },
    { name: 'onError', opt: 'optional', type: T_fn },
    { name: 'onLoading', opt: 'optional', type: T_node },
  ],
  StaticRows: [
    { name: 'defaultSort', opt: 'optional', type: T_record_DefaultSort },
    { name: 'headers', opt: 'required', type: T_list_union_TextSource },
    { name: 'rows', opt: 'required', type: T_list_list_union_TextSource },
    { name: 'sortable', opt: 'optional', type: T_bool },
  ],
  StyleDelta: [
    { name: 'direction', opt: 'optional', type: T_enum_TextDirection },
    { name: 'emphasis', opt: 'optional', type: T_enum_Emphasis },
    { name: 'role', opt: 'optional', type: T_enum_StyleRole },
    { name: 'tone', opt: 'optional', type: T_enum_ToneVariant },
    { name: 'voice', opt: 'optional', type: T_enum_FontVoice },
    { name: 'weight', opt: 'optional', type: T_enum_StyleWeight },
  ],
  SwitchCase: [
    { name: 'child', opt: 'required', type: T_node },
    { name: 'match', opt: 'optional', type: T_str },
    { name: 'when', opt: 'optional', type: T_union_Binding_bool },
  ],
  TabHeader: [
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'icon', opt: 'optional', type: T_str },
    { name: 'disabled', opt: 'optional', type: T_union_Binding_bool },
  ],
  TrackEntry: [
    { name: 'default', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
    { name: 'kind', opt: 'required', type: T_enum_TrackKind },
    { name: 'label', opt: 'required', type: T_union_TextSource },
    { name: 'src', opt: 'required', type: T_union_Binding_str },
    { name: 'srcLang', opt: 'required', type: T_str },
  ],
  TransformParam: [
    { name: 'from', opt: 'required', type: T_union_Binding_json },
    { name: 'name', opt: 'required', type: T_str },
  ],
  TreeItem: [
    {
      name: 'children',
      opt: 'omitDefault',
      type: T_list_record_TreeItem,
      dflt: { $type: 'list', items: [] },
    },
    { name: 'icon', opt: 'optional', type: T_str },
    { name: 'id', opt: 'required', type: T_str },
    { name: 'label', opt: 'required', type: T_union_TextSource },
  ],
  ViewBox: [
    { name: 'height', opt: 'required', type: T_float },
    { name: 'minX', opt: 'required', type: T_float },
    { name: 'minY', opt: 'required', type: T_float },
    { name: 'width', opt: 'required', type: T_float },
  ],
} as const satisfies Record<string, readonly FieldRow[]>;
export type RecordName = keyof typeof RECORD_FIELDS;

// ─── Unions ──────────────────────────────────────────────────────────────────

/** Each tagged union's cases, each case's field table, in IDL order. */
export const UNION_CASES = {
  Action: {
    Chain: [{ name: 'ops', opt: 'required', type: T_list_union_Action }],
    WriteToClipboard: [{ name: 'text', opt: 'required', type: T_union_TextSource }],
    Dispatch: [{ name: 'msg', opt: 'hostOnly', type: T_fn }],
    Invoke: [
      { name: 'capabilityId', opt: 'required', type: T_str },
      { name: 'args', opt: 'required', type: T_list_record_InvokeArg },
    ],
    ReadFileBody: [
      { name: 'fileRef', opt: 'required', type: T_str },
      { name: 'fileHandle', opt: 'hostOnly', type: T_fn },
      { name: 'encoding', opt: 'required', type: T_enum_FileReadEncoding },
      { name: 'onRead', opt: 'optional', type: T_fn },
    ],
    Call: [
      { name: 'endpoint', opt: 'required', type: T_str },
      { name: 'onResult', opt: 'optional', type: T_fn },
      { name: 'into', opt: 'optional', type: T_union_CallResultTarget },
    ],
    Navigate: [
      { name: 'route', opt: 'required', type: T_union_TextSource },
      {
        name: 'target',
        opt: 'omitDefault',
        type: T_enum_NavigateTarget,
        dflt: { $type: 'enum', case: 'Self' },
      },
    ],
    CommitLocal: [{ name: 'nodeId', opt: 'required', type: T_str }],
    Notify: [
      { name: 'channel', opt: 'required', type: T_str },
      { name: 'payload', opt: 'required', type: T_json },
    ],
    SetState: [
      { name: 'key', opt: 'required', type: T_str },
      { name: 'value', opt: 'optional', type: T_json },
      { name: 'valueFrom', opt: 'optional', type: T_union_Binding_json },
    ],
    AiTool: [
      { name: 'toolName', opt: 'required', type: T_str },
      { name: 'args', opt: 'required', type: T_json },
    ],
    Print: [],
    Confirm: [
      { name: 'prompt', opt: 'required', type: T_union_TextSource },
      { name: 'onConfirm', opt: 'required', type: T_union_Action },
      { name: 'onCancel', opt: 'optional', type: T_union_Action },
    ],
    Focus: [{ name: 'nodeId', opt: 'required', type: T_str }],
  },
  Binding: {
    Static: [{ name: 'value', opt: 'optional', type: T_var_T }],
    Query: [
      { name: 'name', opt: 'required', type: T_str },
      { name: 'accessor', opt: 'hostOnly', type: T_fn },
      { name: 'dependsOn', opt: 'optional', type: T_list_str },
    ],
    Filter: [
      { name: 'name', opt: 'required', type: T_str },
      { name: 'defaultValue', opt: 'optional', type: T_var_T },
    ],
    Selection: [
      { name: 'nodeId', opt: 'required', type: T_str },
      { name: 'accessor', opt: 'hostOnly', type: T_fn },
      { name: 'defaultValue', opt: 'optional', type: T_var_T },
      { name: 'field', opt: 'optional', type: T_str },
    ],
    State: [
      { name: 'key', opt: 'required', type: T_str },
      { name: 'defaultValue', opt: 'optional', type: T_var_T },
    ],
    Now: [
      { name: 'accessor', opt: 'hostOnly', type: T_fn },
      { name: 'grain', opt: 'optional', type: T_enum_TimeGrain },
    ],
    Computed: [{ name: 'fn', opt: 'required', type: T_fn }],
    Local: [
      { name: 'flushOn', opt: 'required', type: T_union_LocalFlushTrigger },
      { name: 'format', opt: 'required', type: T_fn },
      { name: 'initialFrom', opt: 'required', type: T_union_Binding_var_T },
      { name: 'onCommit', opt: 'optional', type: T_fn },
      { name: 'parse', opt: 'required', type: T_fn },
      { name: 'codec', opt: 'optional', type: T_union_Format },
      { name: 'commitTo', opt: 'optional', type: T_str },
    ],
    Format: [
      { name: 'source', opt: 'required', type: T_union_Binding_float },
      { name: 'format', opt: 'required', type: T_union_Format },
      { name: 'locale', opt: 'required', type: T_union_LocaleSource },
    ],
    I18n: [
      { name: 'key', opt: 'required', type: T_str },
      { name: 'args', opt: 'optional', type: T_map_union_Binding_json },
    ],
    Transform: [
      { name: 'source', opt: 'required', type: T_hosted },
      { name: 'pipeline', opt: 'required', type: T_list_hosted },
      { name: 'params', opt: 'optional', type: T_list_record_TransformParam },
    ],
    Expr: [
      { name: 'expr', opt: 'required', type: T_hosted },
      { name: 'params', opt: 'optional', type: T_list_record_TransformParam },
    ],
    Invoke: [
      { name: 'capabilityId', opt: 'required', type: T_str },
      { name: 'args', opt: 'required', type: T_list_record_InvokeArg },
    ],
  },
  BoxLayout: {
    Auto: [],
    Flex: [
      { name: 'direction', opt: 'required', type: T_enum_Orientation },
      { name: 'wrap', opt: 'required', type: T_bool },
      { name: 'gap', opt: 'optional', type: T_int },
    ],
    Grid: [
      { name: 'cols', opt: 'required', type: T_int },
      { name: 'templateColumns', opt: 'optional', type: T_str },
      { name: 'gap', opt: 'optional', type: T_int },
    ],
    Masonry: [
      { name: 'cols', opt: 'required', type: T_int },
      { name: 'gap', opt: 'optional', type: T_int },
    ],
  },
  CallResultTarget: {
    State: [{ name: 'key', opt: 'required', type: T_str }],
    Query: [{ name: 'name', opt: 'required', type: T_str }],
  },
  CellFormat: {
    None: [],
    Number: [{ name: 'decimals', opt: 'optional', type: T_int }],
    Currency: [{ name: 'code', opt: 'required', type: T_str }],
    Percent: [{ name: 'decimals', opt: 'optional', type: T_int }],
    SignificantDigits: [{ name: 'digits', opt: 'required', type: T_int }],
    DateTime: [{ name: 'format', opt: 'required', type: T_str }],
    Duration: [
      { name: 'unit', opt: 'required', type: T_enum_DurationUnit },
      { name: 'style', opt: 'required', type: T_enum_DurationStyle },
    ],
    RelativeTime: [{ name: 'unit', opt: 'required', type: T_enum_RelativeTimeUnit }],
    Custom: [{ name: 'fn', opt: 'required', type: T_fn }],
  },
  CellKindErased: {
    Text: [],
    Numeric: [],
    Date: [],
    Editable: [{ name: 'onEdit', opt: 'optional', type: T_fn }],
    Checkbox: [
      { name: 'get', opt: 'required', type: T_fn },
      { name: 'onToggle', opt: 'optional', type: T_fn },
    ],
    Button: [
      { name: 'label', opt: 'required', type: T_union_TextSource },
      { name: 'onClick', opt: 'optional', type: T_fn },
    ],
    ButtonGroup: [{ name: 'buttons', opt: 'required', type: T_list_record_ButtonGroupItem }],
    Link: [
      { name: 'hrefFn', opt: 'required', type: T_fn },
      { name: 'labelFn', opt: 'required', type: T_fn },
    ],
    Pill: [
      { name: 'labelFn', opt: 'required', type: T_fn },
      { name: 'toneFn', opt: 'required', type: T_fn },
    ],
    TonedPill: [
      { name: 'field', opt: 'required', type: T_str },
      { name: 'map', opt: 'required', type: T_map_enum_ToneVariant },
      {
        name: 'default',
        opt: 'omitDefault',
        type: T_enum_ToneVariant,
        dflt: { $type: 'enum', case: 'Default' },
      },
    ],
    Progress: [
      { name: 'fractionFn', opt: 'required', type: T_fn },
      { name: 'labelFn', opt: 'optional', type: T_fn },
    ],
    Custom: [{ name: 'fn', opt: 'required', type: T_fn }],
  },
  ChartAnnotation: {
    ReferenceLine: [
      { name: 'value', opt: 'required', type: T_float },
      { name: 'label', opt: 'optional', type: T_union_TextSource },
    ],
    EventMarker: [
      { name: 'at', opt: 'required', type: T_union_ChartAnnotationX },
      { name: 'label', opt: 'optional', type: T_union_TextSource },
    ],
    RangeBand: [
      { name: 'range', opt: 'required', type: T_union_ChartAnnotationRange },
      { name: 'label', opt: 'optional', type: T_union_TextSource },
    ],
  },
  ChartAnnotationRange: {
    ValueRange: [
      { name: 'from', opt: 'required', type: T_float },
      { name: 'to', opt: 'required', type: T_float },
    ],
    XRange: [
      { name: 'from', opt: 'required', type: T_union_ChartAnnotationX },
      { name: 'to', opt: 'required', type: T_union_ChartAnnotationX },
    ],
  },
  ChartAnnotationX: {
    Category: [{ name: 'key', opt: 'required', type: T_str }],
    Date: [{ name: 'iso', opt: 'required', type: T_str }],
  },
  ColumnWidth: {
    Auto: [],
    Fixed: [{ name: 'pixels', opt: 'required', type: T_int }],
    Flex: [{ name: 'weight', opt: 'required', type: T_float }],
  },
  CurveCommand: {
    MoveTo: [{ name: 'to', opt: 'required', type: T_record_DrawPoint }],
    LineTo: [{ name: 'to', opt: 'required', type: T_record_DrawPoint }],
    CubicTo: [
      { name: 'control1', opt: 'required', type: T_record_DrawPoint },
      { name: 'control2', opt: 'required', type: T_record_DrawPoint },
      { name: 'to', opt: 'required', type: T_record_DrawPoint },
    ],
    QuadraticTo: [
      { name: 'control', opt: 'required', type: T_record_DrawPoint },
      { name: 'to', opt: 'required', type: T_record_DrawPoint },
    ],
    Close: [],
  },
  FormFieldKind: {
    Text: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
    ],
    Number: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
    ],
    Checkbox: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
    ],
    Toggle: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
    ],
    Choice: [
      { name: 'options', opt: 'required', type: T_union_Binding_list_record_SelectOption },
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
    ],
    TextArea: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'rows', opt: 'required', type: T_int },
    ],
    RangedNumber: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'min', opt: 'optional', type: T_float },
      { name: 'max', opt: 'optional', type: T_float },
      { name: 'step', opt: 'optional', type: T_float },
    ],
    Range: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'min', opt: 'optional', type: T_float },
      { name: 'max', opt: 'optional', type: T_float },
      { name: 'step', opt: 'optional', type: T_float },
    ],
    SegmentedChoice: [
      { name: 'options', opt: 'required', type: T_union_Binding_list_record_SelectOption },
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'orientation', opt: 'required', type: T_enum_Orientation },
    ],
    DateTime: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'variant', opt: 'required', type: T_enum_DateTimeVariant },
      { name: 'min', opt: 'optional', type: T_str },
      { name: 'max', opt: 'optional', type: T_str },
      { name: 'step', opt: 'optional', type: T_float },
    ],
    DateTimeRange: [
      { name: 'value', opt: 'optional', type: T_hosted },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'variant', opt: 'required', type: T_enum_DateTimeVariant },
      { name: 'min', opt: 'optional', type: T_str },
      { name: 'max', opt: 'optional', type: T_str },
      { name: 'step', opt: 'optional', type: T_float },
    ],
    Combobox: [
      {
        name: 'allowFreeText',
        opt: 'omitDefault',
        type: T_bool,
        dflt: { $type: 'bool', value: false },
      },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'options', opt: 'required', type: T_union_Binding_list_record_SelectOption },
      { name: 'value', opt: 'optional', type: T_hosted },
    ],
    Rating: [
      {
        name: 'allowHalf',
        opt: 'omitDefault',
        type: T_bool,
        dflt: { $type: 'bool', value: false },
      },
      { name: 'max', opt: 'required', type: T_int },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'value', opt: 'optional', type: T_hosted },
    ],
    Color: [
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'value', opt: 'optional', type: T_hosted },
    ],
    Tokens: [
      {
        name: 'allowFreeText',
        opt: 'omitDefault',
        type: T_bool,
        dflt: { $type: 'bool', value: true },
      },
      { name: 'onChange', opt: 'optional', type: T_fn },
      { name: 'suggestions', opt: 'optional', type: T_union_Binding_list_record_SelectOption },
      { name: 'value', opt: 'optional', type: T_hosted },
    ],
  },
  Format: {
    Number: [{ name: 'decimals', opt: 'optional', type: T_int }],
    Currency: [{ name: 'isoCode', opt: 'required', type: T_str }],
    Percent: [{ name: 'decimals', opt: 'optional', type: T_int }],
    DateTime: [
      { name: 'dateStyle', opt: 'optional', type: T_enum_DateStyle },
      { name: 'timeStyle', opt: 'optional', type: T_enum_TimeStyle },
    ],
    RelativeTime: [{ name: 'unit', opt: 'required', type: T_enum_RelativeTimeUnit }],
    Duration: [
      { name: 'unit', opt: 'required', type: T_enum_DurationUnit },
      { name: 'style', opt: 'required', type: T_enum_DurationStyle },
    ],
    Since: [{ name: 'unit', opt: 'optional', type: T_enum_RelativeTimeUnit }],
  },
  FragmentArg: {
    Int: [{ name: 'value', opt: 'required', type: T_int }],
    Float: [{ name: 'value', opt: 'required', type: T_float }],
    Bool: [{ name: 'value', opt: 'required', type: T_bool }],
    Str: [{ name: 'value', opt: 'required', type: T_str }],
    SlotArg: [{ name: 'tree', opt: 'required', type: T_node }],
  },
  HoleDecl: {
    Value: [
      { name: 'name', opt: 'required', type: T_str },
      { name: 'space', opt: 'required', type: T_union_HoleValueSpace },
      { name: 'default', opt: 'optional', type: T_union_Scalar },
    ],
    Slot: [
      { name: 'name', opt: 'required', type: T_str },
      { name: 'kindConstraint', opt: 'optional', type: T_str },
    ],
    Repeat: [
      { name: 'name', opt: 'required', type: T_str },
      { name: 'countSpace', opt: 'required', type: T_union_HoleValueSpace },
    ],
  },
  HoleValueSpace: {
    IntRange: [
      { name: 'min', opt: 'required', type: T_int },
      { name: 'max', opt: 'required', type: T_int },
    ],
    FloatRange: [
      { name: 'min', opt: 'required', type: T_float },
      { name: 'max', opt: 'required', type: T_float },
    ],
    StringLen: [
      { name: 'minLen', opt: 'required', type: T_int },
      { name: 'maxLen', opt: 'required', type: T_int },
    ],
    Enum: [{ name: 'choices', opt: 'required', type: T_list_str }],
    AnyString: [],
  },
  LocalFlushTrigger: {
    OnBlur: [],
    OnSubmit: [],
    OnDebounce: [{ name: 'milliseconds', opt: 'required', type: T_int }],
    OnCommitAction: [],
  },
  LocaleSource: { Ambient: [], Explicit: [{ name: 'tag', opt: 'required', type: T_str }] },
  MediaKind: {
    Video: [
      { name: 'autoplay', opt: 'omitDefault', type: T_bool, dflt: { $type: 'bool', value: false } },
      { name: 'poster', opt: 'optional', type: T_union_Binding_str },
    ],
    Audio: [],
  },
  Scalar: {
    Int: [{ name: 'value', opt: 'required', type: T_int }],
    Float: [{ name: 'value', opt: 'required', type: T_float }],
    Bool: [{ name: 'value', opt: 'required', type: T_bool }],
    Str: [{ name: 'value', opt: 'required', type: T_str }],
  },
  Shape: {
    Group: [
      { name: 'children', opt: 'required', type: T_list_union_Shape },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Rectangle: [
      { name: 'x', opt: 'required', type: T_float },
      { name: 'y', opt: 'required', type: T_float },
      { name: 'width', opt: 'required', type: T_float },
      { name: 'height', opt: 'required', type: T_float },
      { name: 'cornerRadius', opt: 'optional', type: T_float },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Line: [
      { name: 'x1', opt: 'required', type: T_float },
      { name: 'y1', opt: 'required', type: T_float },
      { name: 'x2', opt: 'required', type: T_float },
      { name: 'y2', opt: 'required', type: T_float },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Polyline: [
      { name: 'points', opt: 'required', type: T_list_record_DrawPoint },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Polygon: [
      { name: 'points', opt: 'required', type: T_list_record_DrawPoint },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Curve: [
      { name: 'commands', opt: 'required', type: T_list_union_CurveCommand },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Circle: [
      { name: 'cx', opt: 'required', type: T_float },
      { name: 'cy', opt: 'required', type: T_float },
      { name: 'r', opt: 'required', type: T_float },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Ellipse: [
      { name: 'cx', opt: 'required', type: T_float },
      { name: 'cy', opt: 'required', type: T_float },
      { name: 'rx', opt: 'required', type: T_float },
      { name: 'ry', opt: 'required', type: T_float },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
    Label: [
      { name: 'x', opt: 'required', type: T_float },
      { name: 'y', opt: 'required', type: T_float },
      { name: 'text', opt: 'required', type: T_union_TextSource },
      { name: 'style', opt: 'required', type: T_record_DrawStyle },
    ],
  },
  TextSource: {
    Literal: [{ name: 'text', opt: 'required', type: T_str }],
    Bound: [{ name: 'binding', opt: 'required', type: T_union_Binding_str }],
    I18n: [
      { name: 'key', opt: 'required', type: T_str },
      { name: 'args', opt: 'required', type: T_map_hosted },
    ],
  },
} as const satisfies Record<string, Record<string, readonly FieldRow[]>>;
export type UnionName = keyof typeof UNION_CASES;
/** The type parameters of the generic unions. */
export const UNION_PARAMS = {
  Binding: ['T'],
} as const satisfies Partial<Record<UnionName, readonly string[]>>;
/** The case a bare wire value lifts into (the transparent unions). */
export const UNION_TRANSPARENT_CASE = {
  TextSource: 'Literal',
} as const satisfies Partial<Record<UnionName, string>>;
/** Per-case annotations the IDL declares. */
export const UNION_CASE_ANNOTATIONS = {
  Action: { Dispatch: { inProcessOnly: true } },
} as const;

// ─── Ops ─────────────────────────────────────────────────────────────────────

export const OP_FIELDS = {
  Batch: [{ name: 'ops', opt: 'required', type: T_list_op }],
  EditNode: [
    { name: 'newKind', opt: 'required', type: T_kind },
    { name: 'target', opt: 'required', type: T_str },
  ],
  InsertChild: [
    { name: 'child', opt: 'required', type: T_node },
    { name: 'parentId', opt: 'required', type: T_str },
  ],
  MoveNode: [
    { name: 'newParentId', opt: 'required', type: T_str },
    { name: 'target', opt: 'required', type: T_str },
  ],
  PatchStyle: [
    { name: 'style', opt: 'required', type: T_record_StyleDelta },
    { name: 'target', opt: 'required', type: T_str },
  ],
  RemoveNode: [{ name: 'target', opt: 'required', type: T_str }],
  ReorderChildren: [
    { name: 'newOrder', opt: 'required', type: T_list_str },
    { name: 'parentId', opt: 'required', type: T_str },
  ],
  ReplaceBinding: [
    { name: 'binding', opt: 'required', type: T_union_Binding_json },
    { name: 'slot', opt: 'required', type: T_str },
    { name: 'target', opt: 'required', type: T_str },
  ],
  ReplaceRoot: [{ name: 'node', opt: 'required', type: T_node }],
  UpdateProp: [
    { name: 'path', opt: 'required', type: T_str },
    { name: 'target', opt: 'required', type: T_str },
    { name: 'value', opt: 'required', type: T_json },
  ],
  UpdateState: [
    { name: 'state', opt: 'required', type: T_record_StateBehaviour },
    { name: 'target', opt: 'required', type: T_str },
  ],
  UpdateStyle: [
    { name: 'style', opt: 'required', type: T_record_SemanticStyle },
    { name: 'target', opt: 'required', type: T_str },
  ],
} as const satisfies Record<string, readonly FieldRow[]>;
export type OpName = keyof typeof OP_FIELDS;

// ─── Hardening ───────────────────────────────────────────────────────────────

export const HARDEN = {
  gatedKind: 'Custom',
  placeholderField: 'text',
  placeholderKind: 'Markdown',
  textLiteralCase: 'Literal',
  textLiteralField: 'text',
  transparentUnions: [
    {
      case: 'Literal',
      union: 'TextSource',
    },
  ],
  valueLiteralCase: 'Static',
  valueLiteralField: 'value',
} as const;

// ─── Derived from the tables above ───────────────────────────────────────────

/** Each kind's node-bearing members (a `node` or a `list<node>`), in IDL order. */
export const CHILD_SLOTS = {
  Badge: [],
  Box: ['children'],
  Button: [],
  Callout: [],
  Chart: [],
  CodeBlock: [],
  Custom: [],
  DataGrid: [],
  Disclosure: ['children'],
  Drawing: [],
  Embed: [],
  ErrorBoundary: ['child', 'fallback'],
  Fact: [],
  FileUpload: [],
  Filters: [],
  Form: [],
  FragmentDecl: ['body'],
  FragmentRef: [],
  Heading: [],
  Icon: [],
  Image: [],
  LabelValueRow: [],
  Link: [],
  List: [],
  Map: [],
  Markdown: [],
  Math: [],
  Media: [],
  Metric: [],
  Modal: ['children'],
  Mount: [],
  Progress: [],
  ScrollArea: ['children'],
  Select: [],
  Skeleton: [],
  Sparkline: [],
  SplitPanel: ['children'],
  Stepper: ['children'],
  SummaryList: ['children'],
  Switch: ['default'],
  Tabs: ['children'],
  Toast: [],
  Tree: [],
} as const satisfies Record<NodeKindName, readonly string[]>;
/** Each kind's binding slots — every `Binding<…>` member, with the slot name the introspection surface reports (the member name in PascalCase), in IDL order. */
export const BINDING_SLOTS = {
  Badge: [],
  Box: [],
  Button: [{ field: 'disabled', slot: 'Disabled', optional: true }],
  Callout: [],
  Chart: [{ field: 'source', slot: 'Source', optional: false }],
  CodeBlock: [],
  Custom: [],
  DataGrid: [
    { field: 'rowTotal', slot: 'RowTotal', optional: true },
    { field: 'source', slot: 'Source', optional: false },
  ],
  Disclosure: [{ field: 'open', slot: 'Open', optional: false }],
  Drawing: [],
  Embed: [{ field: 'src', slot: 'Src', optional: false }],
  ErrorBoundary: [],
  Fact: [],
  FileUpload: [{ field: 'disabled', slot: 'Disabled', optional: true }],
  Filters: [],
  Form: [{ field: 'disabled', slot: 'Disabled', optional: true }],
  FragmentDecl: [],
  FragmentRef: [],
  Heading: [],
  Icon: [],
  Image: [{ field: 'src', slot: 'Src', optional: false }],
  LabelValueRow: [{ field: 'value', slot: 'Value', optional: false }],
  Link: [{ field: 'href', slot: 'Href', optional: false }],
  List: [],
  Map: [{ field: 'source', slot: 'Source', optional: false }],
  Markdown: [],
  Math: [],
  Media: [{ field: 'src', slot: 'Src', optional: false }],
  Metric: [
    { field: 'value', slot: 'Value', optional: false },
    { field: 'trend', slot: 'Trend', optional: true },
  ],
  Modal: [{ field: 'open', slot: 'Open', optional: false }],
  Mount: [],
  Progress: [{ field: 'fraction', slot: 'Fraction', optional: false }],
  ScrollArea: [],
  Select: [
    { field: 'source', slot: 'Source', optional: false },
    { field: 'value', slot: 'Value', optional: false },
    { field: 'disabled', slot: 'Disabled', optional: true },
    { field: 'values', slot: 'Values', optional: true },
  ],
  Skeleton: [],
  Sparkline: [{ field: 'source', slot: 'Source', optional: false }],
  SplitPanel: [],
  Stepper: [{ field: 'activeStep', slot: 'ActiveStep', optional: false }],
  SummaryList: [],
  Switch: [{ field: 'on', slot: 'On', optional: true }],
  Tabs: [
    { field: 'activeIndex', slot: 'ActiveIndex', optional: true },
    { field: 'activeTag', slot: 'ActiveTag', optional: true },
  ],
  Toast: [{ field: 'open', slot: 'Open', optional: false }],
  Tree: [],
} as const satisfies Record<
  NodeKindName,
  readonly { readonly field: string; readonly slot: string; readonly optional: boolean }[]
>;
