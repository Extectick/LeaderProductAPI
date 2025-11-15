$path = "src/routes/tracking.ts"

$text = Get-Content $path -Raw

# Normalize UNAUTHORIZED messages
$text = [regex]::Replace(
    $text,
    "'([^']*)',\s*ErrorCodes\.UNAUTHORIZED",
    "'Пользователь не авторизован', ErrorCodes.UNAUTHORIZED"
)

# Normalize NOT_FOUND messages for routes
$text = [regex]::Replace(
    $text,
    "'([^']*)',\s*ErrorCodes\.NOT_FOUND",
    "'Маршрут не найден или не принадлежит пользователю', ErrorCodes.NOT_FOUND"
)

# Normalize VALIDATION_ERROR messages based on current text
$pattern = "'([^']*)',\s*ErrorCodes\.VALIDATION_ERROR"
$text = [regex]::Replace(
    $text,
    $pattern,
    {
        param($m)
        $msg = $m.Groups[1].Value

        if ($msg -like "*points*") {
            return "'Поле points должно быть непустым массивом', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*batch*" -or $msg -like "*MAX_POINTS_BATCH*") {
            return "`Превышен максимальный размер batch: ${MAX_POINTS_BATCH} точек`, ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*routeId*startNewRoute*") {
            return "'Нельзя одновременно передавать routeId и startNewRoute', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*routeId*" -and $msg -notlike "*startNewRoute*") {
            return "'routeId должен быть целым числом', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*latitude*" -and $msg -like "*longitude*" -and $msg -like "*recordedAt*") {
            return "'Некорректные данные точки: latitude, longitude и recordedAt обязательны', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*recordedAt*" -and $msg -like "*ISO*") {
            return "'Некорректное значение recordedAt (ожидается строка в формате ISO 8601)', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*eventType*" -and $msg -like "*MOVE*" -and $msg -like "*STOP*") {
            return "'eventType должен быть MOVE или STOP', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*from*") {
            return "'Некорректное значение параметра from', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*to*") {
            return "'Некорректное значение параметра to', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*limit*" -and $msg -like "*offset*") {
            return "'limit и offset должны быть целыми числами', ErrorCodes.VALIDATION_ERROR"
        }
        elseif ($msg -like "*format*" -and $msg -like "*gpx*") {
            return "'Неподдерживаемый формат. Допустим только gpx', ErrorCodes.VALIDATION_ERROR"
        }
        else {
            return $m.Value
        }
    }
)

Set-Content $path $text
