#!/bin/
function contains_element {
    local e
    for e in "${@:2}"; do [ "$e" == "$1" ] && return 0; done
    return 1
}

function get_available_random_port {

    # Fetch a random digit
    port=`shuf -i 2000-65000 -n 1`

    # Make sure that the port is available
    nc -w 3 127.0.0.1 $port <<< ?? &> /dev/null
    not_in_global_use=$?  # 1 if the port is available, 0 if the port is in use
    global_ports=`netstat -tlpn4 2>&1 |grep -e "^tcp " |awk '{split ($4,a,":"); print a[2]}'`
    contains_element $port ${global_ports[@]}
    not_in_global_use=`expr $not_in_global_use + $?`
    contains_element $port ${taken_ports[@]}
    not_in_local_use=$?
    not_in_use=`expr $not_in_global_use + $not_in_local_use`

    if [ "$not_in_use" -ne 3 ]; then
        echo $(get_available_random_port)
        return
    fi
    taken_ports+=($port) # We do not want the same port digit to be used more than once
    echo $port
}
