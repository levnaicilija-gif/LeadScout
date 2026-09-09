import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ClientCv, type ClientCvData } from './ClientCv';
export { clientCvText, clientCvAllowed } from './ClientCv';

/** Server-side render of the client CV. Kept apart from the .tsx so route files stay .ts. */
export const renderClientCv = (data: ClientCvData) => renderToBuffer(React.createElement(ClientCv, data) as any);
export type { ClientCvData };

import { InternalCv, type InternalCvData } from './InternalCv';
/** Rendered on demand and never stored: the internal CV exists only for a senior's download. */
export const renderInternalCv = (data: InternalCvData) => renderToBuffer(React.createElement(InternalCv, data) as any);
export type { InternalCvData };
