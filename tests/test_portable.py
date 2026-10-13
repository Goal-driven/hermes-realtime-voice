import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from dashboard import plugin_api as transport
from hermes_realtime_voice import create_voice_router


@pytest.fixture
def client(monkeypatch):
    async def authenticate(authorization: str = Header(default='')):
        if authorization not in {'user-a', 'user-b'}:
            raise HTTPException(401)
        return authorization

    async def connect(self):
        return None

    monkeypatch.setattr(transport.VoiceChannel, 'connect', connect)
    app = FastAPI()
    app.include_router(create_voice_router(authenticate), prefix='/voice')
    with TestClient(app) as client:
        yield client
    transport.CHANNELS.clear()


def test_every_route_requires_host_authentication(client):
    for path in ['/voice/status', '/voice/client.js', '/voice/events/poll?channel=' + 'a' * 43]:
        assert client.get(path).status_code == 401
    assert client.post('/voice/channel', json={}).status_code == 401


def test_channel_is_bound_to_authenticated_owner(client):
    a = {'Authorization': 'user-a'}
    b = {'Authorization': 'user-b'}
    channel = client.post('/voice/channel', headers=a, json={}).json()['channel']
    assert client.post('/voice/tts/cancel', headers=b, json={'channel': channel}).status_code == 404
    assert client.post('/voice/channel/close', headers=b, json={'channel': channel}).status_code == 404
    assert client.get('/voice/events/poll', headers=b, params={'channel': channel}).status_code == 404
    assert client.post('/voice/tts/cancel', headers=a, json={'channel': channel}).status_code == 200
    assert client.post('/voice/channel/close', headers=a, json={'channel': channel}).status_code == 200
    assert channel not in transport.CHANNELS


def test_browser_module_is_served_from_installed_package(client):
    response = client.get('/voice/client.js', headers={'Authorization': 'user-a'})
    assert response.status_code == 200
    assert 'export class VoiceController' in response.text
    assert 'DASHSCOPE_API_KEY' not in response.text


def test_unknown_language_is_not_advertised_as_working(client):
    for language in ['pl', 'uk', 'ar', 'ro', 'unknown']:
        assert client.get('/voice/status', params={'language': language}, headers={'Authorization': 'user-a'}).status_code == 422
    for language in ['sv', 'en', 'fr', 'es', 'ru']:
        response = client.get('/voice/status', params={'language': language}, headers={'Authorization': 'user-a'})
        assert response.status_code == 200


def test_example_session_and_stream():
    from examples.app import app
    with TestClient(app, base_url='http://127.0.0.1:8765') as client:
        assert client.get('/voice/status').status_code == 401
        assert client.get('/').status_code == 200
        assert client.get('/voice/status').status_code == 200
        result = client.post('/agent/runs', json={'requestId': 'test-1', 'text': 'Bonjour monde', 'language': 'fr'})
        assert result.status_code == 200
        run = result.json()
        assert run['mode'] == 'echo-demo'
        events = client.get('/agent/runs/' + run['id'] + '/events')
        assert 'Bonjour' in events.text
        assert '"type":"complete"' in events.text
        assert client.get('/voice/status', headers={'Origin': 'https://unrelated.example'}).status_code == 403
        with TestClient(app, base_url='http://127.0.0.1:8765') as other:
            other.get('/')
            assert other.get('/agent/runs/' + run['id'] + '/events').status_code == 404

