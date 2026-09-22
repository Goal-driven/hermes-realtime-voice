(function () {
  'use strict'

  const SDK = window.__HERMES_PLUGIN_SDK__
  const { React, fetchJSON } = SDK
  const { Card, CardContent, CardHeader, CardTitle, Badge } = SDK.components

  function VoiceStatus() {
    const [status, setStatus] = React.useState(null)
    const [error, setError] = React.useState('')

    React.useEffect(() => {
      let live = true
      fetchJSON('/api/plugins/hermes-realtime-voice/status')
        .then(value => { if (live) setStatus(value) })
        .catch(reason => { if (live) setError(reason?.message || 'Status unavailable') })
      return () => { live = false }
    }, [])

    return React.createElement('div', { className: 'mx-auto max-w-3xl space-y-4 p-6' },
      React.createElement(Card, null,
        React.createElement(CardHeader, null,
          React.createElement(CardTitle, null, 'Hermes Realtime Voice')),
        React.createElement(CardContent, { className: 'space-y-3' },
          React.createElement(Badge, { variant: status?.configured ? 'default' : 'secondary' },
            status?.configured ? 'Speech transport ready' : 'Configuration required'),
          error ? React.createElement('p', { className: 'text-sm text-destructive' }, error) : null,
          React.createElement('p', { className: 'text-sm text-muted-foreground' },
            'The active Hermes profile remains the reasoning agent and memory owner. The speech provider handles ASR and exact-text TTS only.'),
          status ? React.createElement('dl', { className: 'grid grid-cols-2 gap-2 text-sm' },
            React.createElement('dt', { className: 'text-muted-foreground' }, 'Provider'),
            React.createElement('dd', null, status.provider),
            React.createElement('dt', { className: 'text-muted-foreground' }, 'ASR'),
            React.createElement('dd', null, status.asr_model),
            React.createElement('dt', { className: 'text-muted-foreground' }, 'TTS'),
            React.createElement('dd', null, status.tts_model),
            React.createElement('dt', { className: 'text-muted-foreground' }, 'Brain'),
            React.createElement('dd', null, 'Active Hermes profile')) : null)))
  }

  window.__HERMES_PLUGINS__.register('hermes-realtime-voice', VoiceStatus)
})()
