import * as React from 'react';
import { Box, Text } from '../ink.js';
import { formatNumber } from '../utils/format.js';
import type { Theme } from '../utils/theme.js';

type Props = {
  agentType: string;
  description?: string;
  name?: string;
  descriptionColor?: keyof Theme;
  taskDescription?: string;
  toolUseCount: number;
  color?: keyof Theme;
  isLast: boolean;
  isResolved: boolean;
  isError: boolean;
  isAsync?: boolean;
  shouldAnimate: boolean;
  lastToolInfo?: string | null;
  hideType?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  streamingText?: string | null;
  nextAction?: string | null;
};

export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  toolUseCount,
  color,
  isLast,
  isResolved,
  isError: _isError,
  isAsync = false,
  shouldAnimate: _shouldAnimate,
  lastToolInfo,
  hideType = false,
  inputTokens,
  outputTokens,
  streamingText,
  nextAction,
}: Props): React.ReactNode {
  const treeChar = isLast ? '└─ ' : '├─ ';
  const isBackgrounded = isAsync && isResolved;

  const getStatusText = (): string => {
    if (!isResolved) {
      return nextAction || lastToolInfo || 'Initializing…';
    }
    if (isBackgrounded) {
      return taskDescription ?? 'Running in the background';
    }
    return 'Done';
  };

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        <Text dimColor>{treeChar} </Text>
        <Text dimColor={isResolved}>
          {hideType ? (
            <>
              <Text bold>{name ?? description ?? agentType}</Text>
              {name && description && <Text dimColor>: {description}</Text>}
            </>
          ) : (
            <>
              <Text
                bold
                backgroundColor={color}
                color={color ? 'inverseText' : undefined}
              >
                {agentType}
              </Text>
              {description && (
                <>
                  {' ('}
                  <Text
                    backgroundColor={descriptionColor}
                    color={descriptionColor ? 'inverseText' : undefined}
                  >
                    {description}
                  </Text>
                  {')'}
                </>
              )}
            </>
          )}
          {!isBackgrounded && (
            <>
              {' · '}
              {toolUseCount} tool {toolUseCount === 1 ? 'use' : 'uses'}
              {inputTokens != null && (
                <>
                  {' · '}
                  {formatNumber(inputTokens)} in ·{' '}
                  {formatNumber(outputTokens ?? 0)} out
                </>
              )}
            </>
          )}
        </Text>
      </Box>
      {!isBackgrounded && (
        <Box paddingLeft={3} flexDirection="row">
          <Text dimColor>{isLast ? '  ↳ ' : '│ ↳ '}</Text>
          <Text dimColor>{getStatusText()}</Text>
        </Box>
      )}
      {!isBackgrounded && !isResolved && streamingText && (
        <Box paddingLeft={3} flexDirection="row">
          <Text dimColor>{isLast ? '  ↳ ' : '│ ↳ '}</Text>
          <Text dimColor wrap="truncate-end">
            {streamingText}
          </Text>
        </Box>
      )}
    </Box>
  );
}
