import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ClientCv, type ClientCvData } from './ClientCv';
export { clientCvText, clientCvAllowed } from './ClientCv';

/** Server-side render of the client CV. Kept apart from the .tsx so route files stay .ts. */
export const renderClientCv = (data: ClientCvData) => renderToBuffer(React.createElement(ClientCv, data) as any);
export type { ClientCvData };
