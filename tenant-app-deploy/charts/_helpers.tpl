{{- define "ims.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ims.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "ims.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ims.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "ims.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ims
ims.example.com/tenant: {{ .Values.tenant.name | quote }}
{{- end -}}

{{- define "ims.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ims.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ims.imsApiName" -}}
{{ include "ims.fullname" . }}
{{- end -}}

{{- define "ims.workerApiName" -}}
{{ printf "%s-worker" (include "ims.fullname" .) }}
{{- end -}}

{{- define "ims.configMapName" -}}
{{ printf "%s-config" (include "ims.fullname" .) }}
{{- end -}}