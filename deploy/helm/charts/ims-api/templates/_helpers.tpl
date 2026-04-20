{{- define "ims-api.name" -}}
core-api
{{- end -}}

{{- define "ims-api.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "ims-api.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ims-api.labels" -}}
app.kubernetes.io/name: {{ include "ims-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ims-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ims-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
