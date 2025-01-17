import { getUnifiedGraphGracefully } from '@graphql-mesh/fusion-composition';
import type { OnFetchHookDonePayload } from '@graphql-mesh/types';
import { useContentEncoding } from '@whatwg-node/server';
import {
  createSchema,
  createYoga,
  type FetchAPI,
  type YogaInitialContext,
} from 'graphql-yoga';
import { afterEach, describe, expect, it, vitest } from 'vitest';
import { createGatewayRuntime, useCustomFetch } from '../src/index';

describe('contentEncoding', () => {
  const fooResolver = vitest.fn((_, __, _context: YogaInitialContext) => {
    return 'bar';
  });
  function decompressResponse(response: Response, fetchAPI: FetchAPI) {
    const encodingFormat = response.headers.get('content-encoding');
    const supportedFormats: CompressionFormat[] = ['gzip', 'deflate'];
    if (!supportedFormats.includes(encodingFormat as CompressionFormat)) {
      return response;
    }
    if (!response.body) {
      return response;
    }
    const decompressionStream = new fetchAPI.DecompressionStream(
      encodingFormat as CompressionFormat,
    );
    return new fetchAPI.Response(
      response.body.pipeThrough(decompressionStream),
      response,
    );
  }
  // Mimic the behavior of the `fetch` API in the browser
  const onFetchDoneSpy = vitest.fn((payload: OnFetchHookDonePayload) => {
    payload.setResponse(
      decompressResponse(payload.response, subgraphServer.fetchAPI),
    );
  });
  const subgraphSchema = createSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        foo: String
      }
    `,
    resolvers: {
      Query: {
        foo: fooResolver,
      },
    },
  });
  const subgraphServer = createYoga({
    schema: subgraphSchema,
    plugins: [useContentEncoding()],
  });
  const gateway = createGatewayRuntime({
    supergraph() {
      return getUnifiedGraphGracefully([
        {
          name: 'subgraph',
          schema: subgraphSchema,
          url: 'http://localhost:4001/graphql',
        },
      ]);
    },
    contentEncoding: {
      subgraphs: ['subgraph'],
    },
    plugins: () => [
      useCustomFetch(
        // @ts-expect-error TODO: MeshFetch is not compatible with @whatwg-node/server fetch
        subgraphServer.fetch,
      ),
      {
        onFetch() {
          return onFetchDoneSpy;
        },
      },
    ],
  });
  afterEach(() => {
    fooResolver.mockClear();
    onFetchDoneSpy.mockClear();
  });
  it('from gateway to subgraph', async () => {
    const response = await gateway.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: `query { foo }`,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const resJson = await response.json();
    expect(resJson).toEqual({
      data: {
        foo: 'bar',
      },
    });
    expect(
      fooResolver.mock.calls[0]?.[2].request.headers.get('content-encoding'),
    ).toBe('gzip');
  });
  it('from subgraph to gateway', async () => {
    const response = await gateway.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: `query { foo }`,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const resJson = await response.json();
    expect(resJson).toEqual({
      data: {
        foo: 'bar',
      },
    });
    expect(
      fooResolver.mock.calls[0]?.[2].request.headers.get('accept-encoding'),
    ).toContain('gzip');
    expect(
      onFetchDoneSpy.mock.calls[0]?.[0].response.headers.get(
        'content-encoding',
      ),
    ).toBe('gzip');
  });
  it('from the client to the gateway', async () => {
    const origBody = JSON.stringify({
      query: `query { foo }`,
    });
    const fakeRequest = new gateway.fetchAPI.Request(
      'http://localhost:4000/graphql',
      {
        method: 'POST',
        body: origBody,
        headers: {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip',
        },
      },
    );
    const compressionStream = new gateway.fetchAPI.CompressionStream('gzip');
    const response = await subgraphServer.fetch(
      'http://localhost:4000/graphql',
      {
        method: 'POST',
        body: fakeRequest.body?.pipeThrough(compressionStream),
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
      },
    );
    const resJson = await response.json();
    expect(resJson).toEqual({
      data: {
        foo: 'bar',
      },
    });
  });
  it('from the gateway to the client', async () => {
    const response = await gateway.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: `query { foo }`,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const decompressedRes = decompressResponse(
      response,
      subgraphServer.fetchAPI,
    );
    const resJson = await decompressedRes.json();
    expect(resJson).toEqual({
      data: {
        foo: 'bar',
      },
    });
  });
});
