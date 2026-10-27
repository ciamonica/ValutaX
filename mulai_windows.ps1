param(
    [ValidateRange(1024, 65535)] [int] $Port = 8000,
    [ValidateSet('index.html', 'website.html')] [string] $Page = 'index.html',
    [switch] $NoBrowser
)

# Server lokal Windows untuk membuka aplikasi tanpa pemasangan tambahan.
$ErrorActionPreference = 'Stop'
if ($PSScriptRoot) { $folder = [IO.Path]::GetFullPath($PSScriptRoot) }
else { $folder = [IO.Path]::GetFullPath((Get-Location).Path) }
$rootPrefix = $folder.TrimEnd('\') + '\'
$url = 'http://localhost:' + $Port + '/'
if ($Page -ne 'index.html') { $url += $Page }
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $folderId = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder)))).Replace('-', '').ToLowerInvariant()
} finally { $sha.Dispose() }

function Open-Application {
    if (-not $NoBrowser) { Start-Process $url }
}

function Send-Response($stream, [int] $status, [string] $type, [byte[]] $body, [bool] $headOnly) {
    $phrases = @{200 = 'OK'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'}
    $headers = "HTTP/1.1 $status $($phrases[$status])`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`nX-Content-Type-Options: nosniff`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $headOnly -and $body.Length) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

$types = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
    '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
    '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
    '.txt' = 'text/plain; charset=utf-8'; '.webmanifest' = 'application/manifest+json'
}
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
try {
    try { $listener.Start() }
    catch {
        try {
            $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:' + $Port + '/__valutax_status__')
            $request.Proxy = $null
            $request.Timeout = 1500
            $response = $request.GetResponse()
            try {
                $reader = New-Object IO.StreamReader($response.GetResponseStream())
                try { $status = $reader.ReadToEnd() | ConvertFrom-Json }
                finally { $reader.Dispose() }
            } finally { $response.Dispose() }
            if ($status.app -eq 'ValutaX' -and $status.folderId -eq $folderId) {
                Write-Host 'ValutaX dari folder ini sudah berjalan. Membuka halaman yang sama.'
                Open-Application
                exit 0
            }
        } catch { }
        throw "Port $Port dipakai server lain. Tutup server tersebut, lalu jalankan kembali aplikasi."
    }
    Write-Host "ValutaX berjalan di $url"
    Write-Host 'Biarkan jendela ini terbuka. Tekan Ctrl+C untuk berhenti.'
    Open-Application
    while ($true) {
        $connection = $listener.AcceptTcpClient()
        $stream = $null
        $reader = $null
        try {
            $stream = $connection.GetStream()
            $stream.ReadTimeout = 1500
            $stream.WriteTimeout = 5000
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) { continue }
            $parts = $requestLine.Split(' ')
            if ($parts.Length -ne 3) { continue }
            $size = $requestLine.Length
            do {
                $line = $reader.ReadLine()
                $size += $line.Length
                if ($size -gt 16384) { throw 'Header permintaan terlalu panjang.' }
            } while ($line)
            $method = $parts[0]
            $headOnly = $method -eq 'HEAD'
            $statusCode = 200
            $type = 'text/plain; charset=utf-8'
            $body = [Text.Encoding]::UTF8.GetBytes('Halaman tidak ditemukan.')
            if ($method -notin @('GET', 'HEAD')) { $statusCode = 405 }
            else {
                $target = [Uri]::UnescapeDataString($parts[1].Split('?')[0])
                if (-not $target.StartsWith('/')) { $statusCode = 400 }
                elseif ($target -eq '/__valutax_status__') {
                    $type = 'application/json; charset=utf-8'
                    $body = [Text.Encoding]::UTF8.GetBytes((@{app = 'ValutaX'; folderId = $folderId} | ConvertTo-Json -Compress))
                } else {
                    if ($target -eq '/') { $target = '/index.html' }
                    try { $path = [IO.Path]::GetFullPath([IO.Path]::Combine($folder, $target.TrimStart('/').Replace('/', '\'))) }
                    catch { $path = ''; $statusCode = 400 }
                    if ($statusCode -eq 200) {
                        if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { $statusCode = 403 }
                        elseif (-not [IO.File]::Exists($path)) { $statusCode = 404 }
                        elseif (-not $types.ContainsKey([IO.Path]::GetExtension($path))) { $statusCode = 404 }
                        else {
                            $type = $types[[IO.Path]::GetExtension($path)]
                            $body = [IO.File]::ReadAllBytes($path)
                        }
                    }
                }
            }
            Send-Response $stream $statusCode $type $body $headOnly
        } catch {
            # Koneksi yang ditutup atau permintaan tidak lengkap tidak menghentikan server.
        } finally {
            if ($reader) { $reader.Dispose() }
            if ($stream) { $stream.Dispose() }
            $connection.Dispose()
        }
    }
} catch {
    Write-Error $_
    exit 1
} finally { $listener.Stop() }
